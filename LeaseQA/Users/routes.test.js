import test from "node:test";
import assert from "node:assert/strict";

import userModel from "./model.js";
import router from "./routes.js";
import * as usersDao from "./dao.js";

const getRouteHandler = (method, routePath) => {
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

test("PATCH /me rejects privileged fields without updating the user", async () => {
  const originalFindByIdAndUpdate = userModel.findByIdAndUpdate;
  const updateCalls = [];
  userModel.findByIdAndUpdate = async (...args) => {
    updateCalls.push(args);
    return { _id: "user-1", role: "admin" };
  };

  try {
    const handler = getRouteHandler("patch", "/me");
    const req = {
      body: { role: "admin" },
      session: {
        currentUser: { _id: "user-1", role: "tenant" },
      },
    };
    const res = createResponse();

    await handler(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.payload.error.code, "VALIDATION_ERROR");
    assert.equal(updateCalls.length, 0);
  } finally {
    userModel.findByIdAndUpdate = originalFindByIdAndUpdate;
  }
});

test("createUser enforces tenant role at the persistence boundary", async () => {
  const originalCreate = userModel.create;
  let persistedPayload;
  userModel.create = async (payload) => {
    persistedPayload = payload;
    return payload;
  };

  try {
    await usersDao.createUser({
      username: "Fresh Tenant",
      email: "fresh@example.com",
      password: "leaseqa-secret",
      role: "admin",
      lawyerVerification: { barNumber: "x", state: "MA" },
    });

    assert.equal(persistedPayload.role, "tenant");
    assert.equal(persistedPayload.lawyerVerification, null);
  } finally {
    userModel.create = originalCreate;
  }
});
