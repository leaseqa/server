import test from "node:test";
import assert from "node:assert/strict";

import { createAnswersRouter } from "./routes.js";

const getRouteHandler = (router, method, routePath) => {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === routePath && entry.route.methods?.[method] === true,
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${routePath} route`);
  return layer.route.stack[0].handle;
};

const createResponse = () => ({
  statusCode: 200,
  payload: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.payload = body;
    return this;
  },
});

test("POST / creates an answer and records an inbound answer notification", async () => {
  const recorded = [];
  const router = createAnswersRouter({
    answersDao: {
      createAnswer: async (payload) => ({
        _id: "answer-1",
        ...payload,
      }),
    },
    postsDao: {
      findPostById: async () => ({
        _id: "post-1",
        summary: "Can my landlord charge a late fee?",
        authorId: { toString: () => "tenant-1" },
      }),
    },
    recordActivityFn: async (payload) => {
      recorded.push(payload);
    },
  });
  const handler = getRouteHandler(router, "post", "/");
  const req = {
    body: {
      postId: "post-1",
      content: "Only if the lease or statute allows it.",
      answerType: "community_answer",
    },
    session: {
      currentUser: {
        _id: "lawyer-1",
        role: "lawyer",
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, "answer_received");
  assert.equal(recorded[0].userId, "tenant-1");
  assert.equal(recorded[0].metadata.postId, "post-1");
});

test("POST / rejects lawyer opinions from an unverified lawyer", async () => {
  let createCalls = 0;
  const router = createAnswersRouter({
    answersDao: {
      createAnswer: async (payload) => {
        createCalls += 1;
        return { _id: "answer-1", ...payload };
      },
    },
    postsDao: {
      findPostById: async () => ({
        _id: "post-1",
        summary: "Question",
        authorId: { toString: () => "tenant-1" },
      }),
    },
    recordActivityFn: async () => {},
  });
  const handler = getRouteHandler(router, "post", "/");
  const req = {
    body: {
      postId: "post-1",
      content: "Legal opinion",
      answerType: "lawyer_opinion",
    },
    session: {
      currentUser: {
        _id: "lawyer-1",
        role: "lawyer",
        lawyerVerification: { barNumber: "123", state: "MA" },
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error.code, "FORBIDDEN");
  assert.equal(createCalls, 0);
});

test("POST / accepts a verified lawyer opinion and sanitizes it before persistence", async () => {
  let createdPayload;
  const router = createAnswersRouter({
    answersDao: {
      createAnswer: async (payload) => {
        createdPayload = payload;
        return { _id: "answer-1", ...payload };
      },
    },
    postsDao: {
      findPostById: async () => ({
        _id: "post-1",
        summary: "Question",
        authorId: { toString: () => "tenant-1" },
      }),
    },
    recordActivityFn: async () => {},
  });
  const handler = getRouteHandler(router, "post", "/");
  const req = {
    body: {
      postId: "post-1",
      content: '<p>Legal opinion</p><img src=x onerror="alert(1)"><script>alert(2)</script>',
      answerType: "lawyer_opinion",
    },
    session: {
      currentUser: {
        _id: "lawyer-1",
        role: "lawyer",
        lawyerVerification: { verifiedAt: "2026-08-19T00:00:00.000Z" },
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(createdPayload.content, "<p>Legal opinion</p>");
});

test("PUT /:answerId sanitizes changed answer content before persistence", async () => {
  let storedUpdates;
  const router = createAnswersRouter({
    answersDao: {
      findAnswerById: async () => ({
        _id: "answer-1",
        authorId: { toString: () => "tenant-1" },
      }),
      updateAnswer: async (_id, updates) => {
        storedUpdates = updates;
        return { _id: "answer-1", ...updates };
      },
    },
  });
  const handler = getRouteHandler(router, "put", "/:answerId");
  const req = {
    params: { answerId: "answer-1" },
    body: { content: '<blockquote>Keep</blockquote><a href="data:text/html,x">bad</a>' },
    session: { currentUser: { _id: "tenant-1", role: "tenant" } },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(storedUpdates.content, "<blockquote>Keep</blockquote><a>bad</a>");
});

test("PUT /:answerId rejects changing an answer to lawyer opinion without verification", async () => {
  let updateCalls = 0;
  const router = createAnswersRouter({
    answersDao: {
      findAnswerById: async () => ({
        _id: "answer-1",
        authorId: { toString: () => "lawyer-1" },
      }),
      updateAnswer: async () => {
        updateCalls += 1;
      },
    },
  });
  const handler = getRouteHandler(router, "put", "/:answerId");
  const req = {
    params: { answerId: "answer-1" },
    body: { answerType: "lawyer_opinion" },
    session: {
      currentUser: {
        _id: "lawyer-1",
        role: "lawyer",
        lawyerVerification: { barNumber: "123", state: "MA" },
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error.code, "FORBIDDEN");
  assert.equal(updateCalls, 0);
});
