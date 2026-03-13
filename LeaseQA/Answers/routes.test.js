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
