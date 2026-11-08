import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import {
  acceptsEventStream,
  createEventStream,
  saveSessionBeforeStream,
} from "./eventStream.js";

const listen = async (app) =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });

const requestWithAccept = (accept) => ({
  get: (name) => (name.toLowerCase() === "accept" ? accept : undefined),
});

test("only an explicit text/event-stream Accept header asks for a stream", () => {
  assert.equal(acceptsEventStream(requestWithAccept("text/event-stream")), true);
  assert.equal(
    acceptsEventStream(requestWithAccept("application/json, text/event-stream;q=0.9")),
    true,
  );
  assert.equal(acceptsEventStream(requestWithAccept("*/*")), false);
  assert.equal(acceptsEventStream(requestWithAccept("application/json")), false);
  assert.equal(acceptsEventStream(requestWithAccept("text/event-streams")), false);
  assert.equal(acceptsEventStream(requestWithAccept(undefined)), false);
});

test("the stream opens on the first event and frames each one as an SSE event", async (t) => {
  const app = express();
  app.get("/stream", (_req, res) => {
    const stream = createEventStream(res);
    assert.equal(stream.opened, false);
    stream.send("status", { stage: "retrieving" });
    assert.equal(stream.opened, true);
    stream.send("delta", { part: "summary", text: "line one\nline two" });
    stream.done(null);
  });

  const server = await listen(app);
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/stream`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(
    await response.text(),
    'event: status\ndata: {"stage":"retrieving"}\n\n' +
      'event: delta\ndata: {"part":"summary","text":"line one\\nline two"}\n\n' +
      'event: done\ndata: {"data":null}\n\n',
  );
});

test("a stream that never opens leaves the response free for a JSON error", async (t) => {
  const app = express();
  app.get("/stream", (_req, res) => {
    const stream = createEventStream(res);
    if ( !stream.opened ) {
      res.status(404).json({ error: { code: "NOT_FOUND" } });
    }
  });

  const server = await listen(app);
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/stream`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: "NOT_FOUND" } });
});

test("heartbeats keep an idle stream alive as SSE comments", async (t) => {
  const app = express();
  app.get("/stream", (_req, res) => {
    const stream = createEventStream(res, { heartbeatMs: 10 });
    stream.send("status", { stage: "generating" });
    setTimeout(() => stream.done(null), 45);
  });

  const server = await listen(app);
  t.after(() => server.close());
  const body = await (
    await fetch(`http://127.0.0.1:${server.address().port}/stream`)
  ).text();

  assert.match(body, /^event: status\n/);
  assert.match(body, /\n\n: keep-alive\n\n/);
});

test("writes after the client disconnects are dropped, and send says so", async (t) => {
  let stream;
  let firstSend;
  let closed;
  const disconnected = new Promise((resolve) => {
    closed = resolve;
  });
  const app = express();
  app.get("/stream", (_req, res) => {
    stream = createEventStream(res, { heartbeatMs: 5 });
    res.on("close", closed);
    firstSend = stream.send("status", { stage: "retrieving" });
  });

  const server = await listen(app);
  t.after(() => server.close());
  const controller = new AbortController();
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/stream`,
    { signal: controller.signal },
  );
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await disconnected;

  assert.equal(firstSend, true);
  assert.equal(stream.send("delta", { part: "summary", text: "late" }), false);
  assert.doesNotThrow(() => stream.done({ answer: "stored anyway" }));
  assert.doesNotThrow(() => stream.fail({ code: "RAG_MESSAGE_FAILED", message: "late", status: 500 }));
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
});

test("a client that leaves before the first event is noticed, and the stream never opens", async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let result;
  const app = express();
  app.get("/stream", async (_req, res) => {
    const stream = createEventStream(res);
    // Still working on the first event when the client goes away.
    await held;
    result = { delivered: stream.send("status", { stage: "retrieving" }), opened: stream.opened };
  });

  const server = await listen(app);
  t.after(() => server.close());
  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${server.address().port}/stream`, {
    signal: controller.signal,
  }).catch(() => {});
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
  controller.abort();
  await request;
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
  release();
  await new Promise((resolve) => {
    setTimeout(resolve, 10);
  });

  assert.deepEqual(result, { delivered: false, opened: false });
});

test("the session is stored before the stream opens when a store is attached", async () => {
  const calls = [];
  await saveSessionBeforeStream({
    session: {
      save: (callback) => {
        calls.push("save");
        callback();
      },
    },
  });
  assert.deepEqual(calls, ["save"]);

  await assert.doesNotReject(saveSessionBeforeStream({ session: {} }));
  await assert.rejects(
    saveSessionBeforeStream({
      session: { save: (callback) => callback(new Error("store down")) },
    }),
    /store down/,
  );
});

test("done and fail end the stream with the same bodies the JSON responses carry", async (t) => {
  const app = express();
  app.get("/done", (_req, res) => {
    const stream = createEventStream(res);
    stream.send("status", { stage: "retrieving" });
    stream.done({ answer: "ok" });
    stream.send("ignored", {});
  });
  app.get("/fail", (_req, res) => {
    const stream = createEventStream(res);
    stream.send("status", { stage: "generating" });
    stream.fail({ code: "RAG_MESSAGE_FAILED", message: "Failed to answer question.", status: 500 });
  });

  const server = await listen(app);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal(
    await (await fetch(`${base}/done`)).text(),
    'event: status\ndata: {"stage":"retrieving"}\n\n' +
      'event: done\ndata: {"data":{"answer":"ok"}}\n\n',
  );
  assert.equal(
    await (await fetch(`${base}/fail`)).text(),
    'event: status\ndata: {"stage":"generating"}\n\n' +
      'event: error\ndata: {"error":{"code":"RAG_MESSAGE_FAILED","message":"Failed to answer question."},"status":500}\n\n',
  );
});
