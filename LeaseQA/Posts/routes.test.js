import test from "node:test";
import assert from "node:assert/strict";

import { createPostsRouter } from "./routes.js";

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
