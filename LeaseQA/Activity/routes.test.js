import test from "node:test";
import assert from "node:assert/strict";

import { createActivityRouter } from "./routes.js";

const getRouteHandler = (router, method, routePath) => {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === routePath && entry.route.methods?.[method] === true,
  );
  assert.ok(layer, `Expected ${method.toUpperCase()} ${routePath} route`);
  return layer.route.stack[0].handle;
};

const createResponse = () => {
  const response = {
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
  };
  return response;
};

test("GET / returns activity for the current user newest first", async () => {
  const expected = [
    { _id: "activity-2", type: "answer_received" },
    { _id: "activity-1", type: "post_created" },
  ];
  const router = createActivityRouter({
    listActivityForUser: async (userId, options) => {
      assert.equal(userId, "user-1");
      assert.equal(options.limit, 20);
      return expected;
    },
  });
  const req = {
    query: {},
    session: { currentUser: { _id: "user-1", role: "tenant" } },
  };
  const res = createResponse();
  const handler = getRouteHandler(router, "get", "/");

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data, expected);
});

test("GET /notifications returns only unread notification entries", async () => {
  const expected = [{ _id: "activity-2", type: "discussion_received", readAt: null }];
  const router = createActivityRouter({
    listUnreadNotificationsForUser: async (userId, options) => {
      assert.equal(userId, "user-1");
      assert.equal(options.limit, 5);
      return expected;
    },
  });
  const req = {
    query: {},
    session: { currentUser: { _id: "user-1", role: "tenant" } },
  };
  const res = createResponse();
  const handler = getRouteHandler(router, "get", "/notifications");

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data, expected);
});

test("POST /notifications/read marks the selected notifications as read", async () => {
  const router = createActivityRouter({
    markActivitiesRead: async (userId, ids) => {
      assert.equal(userId, "user-1");
      assert.deepEqual(ids, ["activity-1", "activity-2"]);
      return { updatedCount: 2 };
    },
  });
  const req = {
    body: { ids: ["activity-1", "activity-2"] },
    session: { currentUser: { _id: "user-1", role: "tenant" } },
  };
  const res = createResponse();
  const handler = getRouteHandler(router, "post", "/notifications/read");

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.data, { updatedCount: 2 });
});
