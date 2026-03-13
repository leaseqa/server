import test from "node:test";
import assert from "node:assert/strict";

import { createAuthRouter } from "./routes.js";

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
  clearedCookie: undefined,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.payload = body;
    return this;
  },
  clearCookie(name) {
    this.clearedCookie = name;
    return this;
  },
});

test("POST /register creates a user and persists a sanitized session", async () => {
  const router = createAuthRouter({
    findUserByEmail: async () => null,
    createUser: async ({ username, email }) => ({
      _id: "user-1",
      username,
      email,
      role: "tenant",
      hashedPassword: "secret",
    }),
    sanitizeUser: (user) => ({
      _id: user._id,
      username: user.username,
      email: user.email,
      role: user.role,
    }),
  });
  const handler = getRouteHandler(router, "post", "/register");
  const req = {
    body: {
      username: "Fresh Tenant",
      email: "fresh@example.com",
      password: "leaseqa-secret",
    },
    session: {
      save(callback) {
        callback(null);
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.payload.data, {
    _id: "user-1",
    username: "Fresh Tenant",
    email: "fresh@example.com",
    role: "tenant",
  });
  assert.deepEqual(req.session.currentUser, res.payload.data);
});

test("POST /login creates a session for a valid user", async () => {
  const router = createAuthRouter({
    findUserByEmail: async () => ({
      _id: "user-1",
      email: "tenant@example.com",
      hashedPassword: "hashed-password",
      role: "tenant",
      banned: false,
      toObject() {
        return {
          _id: "user-1",
          email: "tenant@example.com",
          username: "Tenant",
          hashedPassword: "hashed-password",
          role: "tenant",
          banned: false,
        };
      },
    }),
    verifyPassword: () => true,
  });
  const handler = getRouteHandler(router, "post", "/login");
  const req = {
    body: {
      email: "tenant@example.com",
      password: "leaseqa-secret",
    },
    sessionID: "session-1",
    session: {
      save(callback) {
        callback(null);
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(req.session.currentUser.email, "tenant@example.com");
  assert.equal(req.session.currentUser.hashedPassword, undefined);
});

test("GET /session returns unauthorized when the session is empty", async () => {
  const router = createAuthRouter();
  const handler = getRouteHandler(router, "get", "/session");
  const req = {
    sessionID: "session-1",
    session: {},
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error.code, "UNAUTHORIZED");
});

test("POST /logout destroys the session and clears the cookie", async () => {
  const router = createAuthRouter();
  const handler = getRouteHandler(router, "post", "/logout");
  const req = {
    session: {
      destroy(callback) {
        callback();
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.clearedCookie, "connect.sid");
  assert.deepEqual(res.payload.data, { success: true });
});
