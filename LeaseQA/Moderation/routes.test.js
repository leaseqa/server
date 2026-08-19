import test from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";

import router from "./routes.js";
import PostModel from "../Posts/model.js";
import UserModel from "../Users/model.js";

const getRouteHandler = (method, routePath) => {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods?.[method] === true,
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

test("moderation state is represented by persisted schema defaults", () => {
  const user = new UserModel({ username: "Tenant", email: "tenant@example.com" });
  const post = new PostModel({
    authorId: new Types.ObjectId(),
    summary: "Question",
    details: "<p>Details</p>",
  });

  assert.equal(user.banned, false);
  assert.equal(post.isHidden, false);
  assert.equal(user.toObject().banned, false);
  assert.equal(post.toObject().isHidden, false);
});

test("POST /posts/:postId/hide directly awaits and returns the resolved update", async (t) => {
  const originalFindById = PostModel.findById;
  const originalFindByIdAndUpdate = PostModel.findByIdAndUpdate;
  t.after(() => {
    PostModel.findById = originalFindById;
    PostModel.findByIdAndUpdate = originalFindByIdAndUpdate;
  });

  const persisted = { _id: "post-1", isHidden: true };
  let findCalls = 0;
  let update;
  PostModel.findById = async () => {
    findCalls += 1;
    return { _id: "post-1", isHidden: false };
  };
  PostModel.findByIdAndUpdate = async (id, updates, options) => {
    update = { id, updates, options };
    return persisted;
  };

  const handler = getRouteHandler("post", "/posts/:postId/hide");
  const req = {
    params: { postId: "post-1" },
    body: { isHidden: true },
    session: { currentUser: { _id: "admin-1", role: "admin" } },
  };
  const res = createResponse();

  await handler(req, res);

  assert.deepEqual(update, {
    id: "post-1",
    updates: { isHidden: true },
    options: { new: true },
  });
  assert.equal(findCalls, 0);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.data, persisted);
});

test("POST /posts/:postId/hide returns 404 when the resolved update is null", async (t) => {
  const originalFindById = PostModel.findById;
  const originalFindByIdAndUpdate = PostModel.findByIdAndUpdate;
  t.after(() => {
    PostModel.findById = originalFindById;
    PostModel.findByIdAndUpdate = originalFindByIdAndUpdate;
  });

  let findCalls = 0;
  let updateCalls = 0;
  PostModel.findById = async () => {
    findCalls += 1;
    return { _id: "missing" };
  };
  PostModel.findByIdAndUpdate = async () => {
    updateCalls += 1;
    return null;
  };

  const handler = getRouteHandler("post", "/posts/:postId/hide");
  const req = {
    params: { postId: "missing" },
    body: { isHidden: true },
    session: { currentUser: { _id: "admin-1", role: "admin" } },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.payload.error.code, "NOT_FOUND");
  assert.equal(findCalls, 0);
  assert.equal(updateCalls, 1);
});
