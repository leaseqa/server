import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPostsRouter } from "./routes.js";
import { createAttachmentUpload } from "./uploadPolicy.js";

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

test("POST / creates a post and writes account activity for the author", async () => {
  const recorded = [];
  const router = createPostsRouter({
    postsDao: {
      createPost: async (payload) => ({
        _id: "post-1",
        ...payload,
      }),
    },
    recordActivityFn: async (payload) => {
      recorded.push(payload);
    },
  });
  const handler = getRouteHandler(router, "post", "/");
  const req = {
    body: {
      summary: "Can my landlord enter without notice?",
      details: "I need to know the Massachusetts notice rule.",
      folders: ["folder-1"],
    },
    session: {
      currentUser: {
        _id: "tenant-1",
        role: "tenant",
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, "post_created");
  assert.equal(recorded[0].userId, "tenant-1");
});

test("POST / sanitizes rich-text details before persistence", async () => {
  let createdPayload;
  const router = createPostsRouter({
    postsDao: {
      createPost: async (payload) => {
        createdPayload = payload;
        return { _id: "post-1", ...payload };
      },
    },
    recordActivityFn: async () => {},
  });
  const handler = getRouteHandler(router, "post", "/");
  const req = {
    body: {
      summary: "Unsafe markup",
      details: '<p>Keep me</p><img src=x onerror="alert(1)"><script>alert(2)</script>',
      folders: ["folder-1"],
    },
    session: { currentUser: { _id: "tenant-1", role: "tenant" } },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(createdPayload.details, "<p>Keep me</p>");
});

test("PUT /:postId writes a post status activity when resolved state changes", async () => {
  const recorded = [];
  const router = createPostsRouter({
    postsDao: {
      findPostById: async () => ({
        _id: "post-1",
        summary: "Can a landlord refuse repairs?",
        authorId: { toString: () => "tenant-1" },
        isResolved: false,
      }),
      updatePost: async (_id, updates) => ({
        _id: "post-1",
        summary: "Can a landlord refuse repairs?",
        authorId: { toString: () => "tenant-1" },
        ...updates,
      }),
    },
    recordActivityFn: async (payload) => {
      recorded.push(payload);
    },
  });
  const handler = getRouteHandler(router, "put", "/:postId");
  const req = {
    params: { postId: "post-1" },
    body: { isResolved: true },
    session: {
      currentUser: {
        _id: "admin-1",
        role: "admin",
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].type, "post_status_changed");
  assert.equal(recorded[0].userId, "tenant-1");
  assert.equal(recorded[0].metadata.isResolved, true);
});

test("PUT /:postId sanitizes changed rich-text details before persistence", async () => {
  let storedUpdates;
  const router = createPostsRouter({
    postsDao: {
      findPostById: async () => ({
        _id: "post-1",
        authorId: { toString: () => "tenant-1" },
        isResolved: false,
        isPinned: false,
      }),
      updatePost: async (_id, updates) => {
        storedUpdates = updates;
        return {
          _id: "post-1",
          authorId: { toString: () => "tenant-1" },
          isResolved: false,
          isPinned: false,
          ...updates,
        };
      },
    },
    recordActivityFn: async () => {},
  });
  const handler = getRouteHandler(router, "put", "/:postId");
  const req = {
    params: { postId: "post-1" },
    body: { details: '<ul><li>Safe</li></ul><a href="javascript:alert(1)">bad</a>' },
    session: { currentUser: { _id: "tenant-1", role: "tenant" } },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(storedUpdates.details, "<ul><li>Safe</li></ul><a>bad</a>");
});

test("GET /:postId hides a moderated post from a non-admin viewer", async () => {
  let incrementCalls = 0;
  const router = createPostsRouter({
    postsDao: {
      findPostById: async () => {
        const post = {
          _id: "post-1",
          isHidden: true,
          authorId: "tenant-1",
        };
        return { ...post, toObject: () => post };
      },
      incrementViewCount: async () => {
        incrementCalls += 1;
      },
    },
    answersDao: { findAnswersByPostId: async () => [] },
    discussionsDao: { findDiscussionTreeForPost: async () => [] },
    buildUserMapFn: async () => ({}),
  });
  const handler = getRouteHandler(router, "get", "/:postId");
  const req = {
    params: { postId: "post-1" },
    session: { currentUser: { _id: "tenant-2", role: "tenant" } },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.error.code, "NOT_FOUND");
  assert.equal(incrementCalls, 0);
});

test("POST /:postId/attachments stores accepted files through the configured policy", async (t) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "leaseqa-route-upload-"));
  const legacyRoot = path.resolve(process.cwd(), "uploads");
  const legacyBefore = new Set(await readdir(legacyRoot));
  t.after(async () => {
    await rm(storageRoot, { recursive: true, force: true });
    for (const filename of await readdir(legacyRoot)) {
      if ( !legacyBefore.has(filename) ) {
        await rm(path.join(legacyRoot, filename), { force: true });
      }
    }
  });

  const post = {
    _id: "post-1",
    authorId: { toString: () => "tenant-1" },
    attachments: [],
    async save() {
      return this;
    },
  };
  const attachmentUpload = createAttachmentUpload({
    SERVER_ENV: "development",
    UPLOADS_DIR: storageRoot,
  });
  const app = express();
  app.use((req, _res, next) => {
    req.session = { currentUser: { _id: "tenant-1", role: "tenant" } };
    next();
  });
  app.use(createPostsRouter({
    postsDao: { findPostById: async () => post },
    attachmentUpload,
  }));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));

  const body = new FormData();
  body.append("files", new Blob(["%PDF-test"], { type: "application/pdf" }), "tenant-lease.pdf");
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/post-1/attachments`,
    { method: "POST", body },
  );
  const payload = await response.json();
  const attachment = payload.data.attachments[0];
  const storedName = new URL(attachment.url).pathname.split("/").at(-1);

  assert.equal(response.status, 200);
  assert.equal(attachment.filename, "tenant-lease.pdf");
  assert.match(storedName, /^[0-9a-f-]{36}\.pdf$/);
  assert.notEqual(storedName, attachment.filename);
  await access(path.join(storageRoot, storedName));
});

test("POST /:postId/attachments rejects a non-owner before writing a file", async (t) => {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), "leaseqa-route-denied-upload-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const attachmentUpload = createAttachmentUpload({
    SERVER_ENV: "development",
    UPLOADS_DIR: storageRoot,
  });
  const app = express();
  app.use((req, _res, next) => {
    req.session = { currentUser: { _id: "tenant-2", role: "tenant" } };
    next();
  });
  app.use(createPostsRouter({
    postsDao: {
      findPostById: async () => ({
        _id: "post-1",
        authorId: { toString: () => "tenant-1" },
        attachments: [],
      }),
    },
    attachmentUpload,
  }));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));

  const body = new FormData();
  body.append("files", new Blob(["%PDF-test"], { type: "application/pdf" }), "denied.pdf");
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/post-1/attachments`,
    { method: "POST", body },
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await readdir(storageRoot), []);
});

test("GET / bulk-loads all post relations once and preserves the enriched JSON shape", async () => {
  const calls = { answers: 0, discussions: 0, users: 0 };
  const posts = [
    {
      _id: "post-1",
      authorId: "user-1",
      summary: "First",
      toObject() {
        return { _id: this._id, authorId: this.authorId, summary: this.summary };
      },
    },
    {
      _id: "post-2",
      authorId: "user-2",
      summary: "Second",
      toObject() {
        return { _id: this._id, authorId: this.authorId, summary: this.summary };
      },
    },
  ];
  const answersByPost = new Map([
    ["post-1", [{ _id: "answer-1", postId: "post-1", authorId: "user-2", content: "Answer" }]],
    ["post-2", []],
  ]);
  const discussionsByPost = new Map([
    ["post-1", [{
      _id: "discussion-1",
      postId: "post-1",
      authorId: "user-3",
      content: "Follow-up",
      replies: [],
    }]],
    ["post-2", []],
  ]);
  const router = createPostsRouter({
    postsDao: { listPosts: async () => posts },
    answersDao: {
      findAnswersByPostIds: async (postIds) => {
        calls.answers += 1;
        assert.deepEqual(postIds, ["post-1", "post-2"]);
        return answersByPost;
      },
    },
    discussionsDao: {
      findDiscussionTreesByPostIds: async (postIds) => {
        calls.discussions += 1;
        assert.deepEqual(postIds, ["post-1", "post-2"]);
        return discussionsByPost;
      },
    },
    usersDao: {
      findUsersByIds: async (userIds) => {
        calls.users += 1;
        assert.deepEqual([...userIds].sort(), ["user-1", "user-2", "user-3"]);
        return [
          { _id: "user-1", username: "Alice", hashedPassword: "redacted" },
          { _id: "user-2", username: "Bob", hashedPassword: "redacted" },
          { _id: "user-3", username: "Casey", hashedPassword: "redacted" },
        ];
      },
      sanitizeUser: (user) => {
        const { hashedPassword: _hashedPassword, ...safe } = user;
        return safe;
      },
    },
  });
  const handler = getRouteHandler(router, "get", "/");
  const req = { query: {}, session: { currentUser: { role: "tenant" } } };
  const res = createResponse();

  await handler(req, res);

  assert.deepEqual(calls, { answers: 1, discussions: 1, users: 1 });
  assert.deepEqual(res.payload, {
    data: [
      {
        _id: "post-1",
        authorId: "user-1",
        summary: "First",
        author: { _id: "user-1", username: "Alice" },
        answers: [{
          _id: "answer-1",
          postId: "post-1",
          authorId: "user-2",
          content: "Answer",
          author: { _id: "user-2", username: "Bob" },
        }],
        discussions: [{
          _id: "discussion-1",
          postId: "post-1",
          authorId: "user-3",
          content: "Follow-up",
          replies: [],
          author: { _id: "user-3", username: "Casey" },
        }],
      },
      {
        _id: "post-2",
        authorId: "user-2",
        summary: "Second",
        author: { _id: "user-2", username: "Bob" },
        answers: [],
        discussions: [],
      },
    ],
  });
});
