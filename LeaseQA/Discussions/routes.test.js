import test from "node:test";
import assert from "node:assert/strict";

import { createDiscussionsRouter } from "./routes.js";

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

test("POST / notifies the parent discussion author for replies", async () => {
  const recorded = [];
  const router = createDiscussionsRouter({
    discussionsDao: {
      findDiscussionById: async (id) =>
        id === "root-1"
          ? {
            _id: "root-1",
            postId: "post-1",
            authorId: { toString: () => "tenant-2" },
          }
          : null,
      createDiscussion: async (payload) => ({
        _id: "reply-1",
        ...payload,
      }),
    },
    postsDao: {
      findPostById: async () => ({
        _id: "post-1",
        summary: "Can they keep the deposit for paint?",
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
      parentId: "root-1",
      content: "You can challenge ordinary wear and tear charges.",
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
  assert.equal(recorded[0].type, "discussion_received");
  assert.equal(recorded[0].userId, "tenant-2");
  assert.equal(recorded[0].metadata.parentId, "root-1");
});

test("POST / sanitizes discussion rich text before persistence", async () => {
  let createdPayload;
  const router = createDiscussionsRouter({
    discussionsDao: {
      createDiscussion: async (payload) => {
        createdPayload = payload;
        return { _id: "discussion-1", ...payload };
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
      content: '<ol><li>Keep</li></ol><svg onload="alert(1)"></svg><script>alert(2)</script>',
    },
    session: { currentUser: { _id: "tenant-2", role: "tenant" } },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(createdPayload.content, "<ol><li>Keep</li></ol>");
});

test("PATCH /:discussionId sanitizes changed discussion content before persistence", async () => {
  let storedUpdates;
  const router = createDiscussionsRouter({
    discussionsDao: {
      findDiscussionById: async () => ({
        _id: "discussion-1",
        authorId: { toString: () => "tenant-1" },
      }),
      updateDiscussion: async (_id, updates) => {
        storedUpdates = updates;
        return { _id: "discussion-1", ...updates };
      },
    },
  });
  const handler = getRouteHandler(router, "patch", "/:discussionId");
  const req = {
    params: { discussionId: "discussion-1" },
    body: { content: '<p>Keep</p><a href="javascript:alert(1)">bad</a>' },
    session: { currentUser: { _id: "tenant-1", role: "tenant" } },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(storedUpdates.content, "<p>Keep</p><a>bad</a>");
});
