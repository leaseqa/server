import test from "node:test";
import assert from "node:assert/strict";
import express from "express";

import { createAuthRouter } from "./routes.js";
import {
  requestIdMiddleware,
  unexpectedErrorHandler,
} from "../utils/httpSecurity.js";

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
  redirect(location) {
    this.redirectedTo = location;
    return this;
  },
});

const createTrackedSession = () => {
  const events = [];
  let currentUser;
  let regenerated = false;
  let saveCalls = 0;
  const session = {
    regenerate(callback) {
      events.push("regenerate");
      regenerated = true;
      callback(null);
    },
    save(callback) {
      events.push("save");
      saveCalls += 1;
      callback(null);
    },
  };
  Object.defineProperty(session, "currentUser", {
    configurable: true,
    get() {
      return currentUser;
    },
    set(value) {
      events.push(regenerated ? "attach-after-regenerate" : "attach-before-regenerate");
      currentUser = value;
    },
  });
  return {
    session,
    events,
    get saveCalls() {
      return saveCalls;
    },
  };
};

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
      regenerate(callback) {
        callback(null);
      },
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

test("POST /register ignores privileged role and verification input", async () => {
  let createdPayload;
  const router = createAuthRouter({
    findUserByEmail: async () => null,
    createUser: async (payload) => {
      createdPayload = payload;
      return {
        _id: "user-1",
        ...payload,
      };
    },
    sanitizeUser: (user) => user,
  });
  const handler = getRouteHandler(router, "post", "/register");
  const req = {
    body: {
      username: "Fresh Tenant",
      email: "fresh@example.com",
      password: "leaseqa-secret",
      role: "admin",
      lawyerVerification: { barNumber: "x", state: "MA" },
    },
    session: {
      regenerate(callback) {
        callback(null);
      },
      save(callback) {
        callback(null);
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 201);
  assert.equal(createdPayload.role, "tenant");
  assert.equal(createdPayload.lawyerVerification, undefined);
});

test("POST /register regenerates before attaching a sanitized user and saves once", async () => {
  const tracked = createTrackedSession();
  const router = createAuthRouter({
    findUserByEmail: async () => null,
    createUser: async () => ({
      _id: "user-1",
      username: "Fresh Tenant",
      email: "fresh@example.com",
      role: "tenant",
      hashedPassword: "hashed-password",
    }),
    sanitizeUser: ({ hashedPassword: _hashedPassword, ...user }) => user,
  });
  const handler = getRouteHandler(router, "post", "/register");
  const req = {
    body: {
      username: "Fresh Tenant",
      email: "fresh@example.com",
      password: "leaseqa-secret",
    },
    session: tracked.session,
  };
  const res = createResponse();

  await handler(req, res);

  assert.deepEqual(tracked.events, ["regenerate", "attach-after-regenerate", "save"]);
  assert.equal(tracked.saveCalls, 1);
  assert.equal(req.session.currentUser.hashedPassword, undefined);
  assert.equal(res.statusCode, 201);
});

test("POST /register rejects reserved demo emails outside development", async () => {
  const router = createAuthRouter(
    {
      findUserByEmail: async () => null,
      createUser: async () => {
        throw new Error("should not create demo users in production");
      },
      sanitizeUser: (user) => user,
    },
    {
      env: {
        SERVER_ENV: "production",
      },
    },
  );
  const handler = getRouteHandler(router, "post", "/register");
  const req = {
    body: {
      username: "Demo Admin",
      email: "admin@leaseqa.dev",
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

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error.code, "FORBIDDEN");
  assert.equal(req.session.currentUser, undefined);
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
    sanitizeUser: (user) => {
      const { hashedPassword: _hashedPassword, ...safeUser } = user.toObject();
      return safeUser;
    },
  });
  const handler = getRouteHandler(router, "post", "/login");
  const req = {
    body: {
      email: "tenant@example.com",
      password: "leaseqa-secret",
    },
    sessionID: "session-1",
    session: {
      regenerate(callback) {
        callback(null);
      },
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

test("POST /login regenerates before attaching a sanitized user and saves once", async () => {
  const tracked = createTrackedSession();
  const router = createAuthRouter({
    findUserByEmail: async () => ({
      _id: "user-1",
      email: "tenant@example.com",
      username: "Tenant",
      hashedPassword: "hashed-password",
      role: "tenant",
      banned: false,
    }),
    verifyPassword: () => true,
    sanitizeUser: ({ hashedPassword: _hashedPassword, ...user }) => user,
  });
  const handler = getRouteHandler(router, "post", "/login");
  const req = {
    body: {
      email: "tenant@example.com",
      password: "leaseqa-secret",
    },
    session: tracked.session,
  };
  const res = createResponse();

  await handler(req, res);

  assert.deepEqual(tracked.events, ["regenerate", "attach-after-regenerate", "save"]);
  assert.equal(tracked.saveCalls, 1);
  assert.equal(req.session.currentUser.hashedPassword, undefined);
  assert.equal(res.statusCode, 200);
});

test("POST /register forwards session regeneration failures", async () => {
  const router = createAuthRouter({
    findUserByEmail: async () => null,
    createUser: async () => ({ _id: "user-1", role: "tenant" }),
    sanitizeUser: (user) => user,
  });
  const handler = getRouteHandler(router, "post", "/register");
  const req = {
    body: {
      username: "Fresh Tenant",
      email: "fresh@example.com",
      password: "leaseqa-secret",
    },
    session: {
      regenerate(callback) {
        callback(new Error("session backend unavailable"));
      },
      save() {
        assert.fail("save must not run after regeneration fails");
      },
    },
  };
  const res = createResponse();
  let forwardedError;

  await handler(req, res, (error) => {
    forwardedError = error;
  });

  assert.equal(res.payload, undefined);
  assert.ok(forwardedError instanceof Error);
});

test("POST /login forwards session save failures", async () => {
  const router = createAuthRouter({
    findUserByEmail: async () => ({
      _id: "user-1",
      email: "tenant@example.com",
      hashedPassword: "hashed-password",
      role: "tenant",
      banned: false,
    }),
    verifyPassword: () => true,
    sanitizeUser: ({ hashedPassword: _hashedPassword, ...user }) => user,
  });
  const handler = getRouteHandler(router, "post", "/login");
  const req = {
    body: {
      email: "tenant@example.com",
      password: "leaseqa-secret",
    },
    session: {
      regenerate(callback) {
        callback(null);
      },
      save(callback) {
        callback(new Error("session write detail"));
      },
    },
  };
  const res = createResponse();
  let forwardedError;

  await handler(req, res, (error) => {
    forwardedError = error;
  });

  assert.equal(res.payload, undefined);
  assert.ok(forwardedError instanceof Error);
});

test("session save failures receive a correlated centralized error response", async (t) => {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      regenerate(callback) {
        callback(null);
      },
      save(callback) {
        callback(new Error("sensitive session store detail"));
      },
    };
    next();
  });
  app.use(createAuthRouter({
    findUserByEmail: async () => ({
      _id: "user-1",
      email: "tenant@example.com",
      hashedPassword: "hashed-password",
      role: "tenant",
      banned: false,
    }),
    verifyPassword: () => true,
    sanitizeUser: ({ hashedPassword: _hashedPassword, ...user }) => user,
  }));
  app.use(unexpectedErrorHandler);

  const logLines = [];
  const originalError = console.error;
  console.error = (...values) => logLines.push(values.join(" "));
  t.after(() => {
    console.error = originalError;
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "tenant@example.com",
      password: "leaseqa-secret",
    }),
  });
  const payload = await response.json();
  const requestId = response.headers.get("x-request-id");
  const logs = logLines.join("\n");

  assert.equal(response.status, 500);
  assert.equal(payload.error.code, "INTERNAL_ERROR");
  assert.equal(payload.error.requestId, requestId);
  assert.match(logs, new RegExp(requestId));
  assert.doesNotMatch(JSON.stringify(payload), /sensitive session store detail/);
  assert.doesNotMatch(logs, /sensitive session store detail/);
});

test("authentication logs omit PII, credentials, session IDs, and session contents", async (t) => {
  const logLines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => logLines.push(values.join(" "));
  console.error = (...values) => logLines.push(values.join(" "));
  t.after(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  const router = createAuthRouter({
    findUserByEmail: async () => ({
      _id: "user-private-id",
      email: "pii@example.com",
      username: "Private Person",
      hashedPassword: "hashed-private-password",
      role: "tenant",
      banned: false,
    }),
    verifyPassword: () => true,
    sanitizeUser: ({ hashedPassword: _hashedPassword, ...user }) => user,
  });
  const login = getRouteHandler(router, "post", "/login");
  const req = {
    body: { email: "pii@example.com", password: "plain-private-password" },
    sessionID: "private-session-id",
    session: {
      regenerate(callback) {
        callback(null);
      },
      save(callback) {
        callback(null);
      },
    },
  };

  await login(req, createResponse());

  const serializedLogs = logLines.join("\n");
  assert.doesNotMatch(
    serializedLogs,
    /pii@example\.com|Private Person|plain-private-password|hashed-private-password|user-private-id|private-session-id/,
  );
});

test("GET /google/callback regenerates before attaching the authenticated user", async () => {
  const tracked = createTrackedSession();
  const router = createAuthRouter({
    sanitizeUser: ({ hashedPassword: _hashedPassword, ...user }) => user,
  }, {
    env: { CLIENT_URL: "https://leaseqa-client.example" },
  });
  const layer = router.stack.find((entry) => entry.route?.path === "/google/callback");
  const handler = layer.route.stack.at(-1).handle;
  const req = {
    user: {
      _id: "user-1",
      email: "oauth@example.com",
      hashedPassword: "hashed-password",
      role: "tenant",
    },
    session: tracked.session,
  };
  const res = createResponse();

  await handler(req, res);

  assert.deepEqual(tracked.events, ["regenerate", "attach-after-regenerate", "save"]);
  assert.equal(req.session.currentUser.hashedPassword, undefined);
  assert.equal(res.redirectedTo, "https://leaseqa-client.example");
});

test("GET /google/callback rejects a banned Passport user before creating a session", async () => {
  const tracked = createTrackedSession();
  const router = createAuthRouter({
    sanitizeUser: ({ hashedPassword: _hashedPassword, ...user }) => user,
  });
  const layer = router.stack.find((entry) => entry.route?.path === "/google/callback");
  const handler = layer.route.stack.at(-1).handle;
  const req = {
    user: {
      _id: "banned-admin-1",
      email: "banned-admin@example.com",
      hashedPassword: "hashed-password",
      role: "admin",
      banned: true,
    },
    session: tracked.session,
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.payload.error.code, "FORBIDDEN");
  assert.deepEqual(tracked.events, []);
  assert.equal(res.redirectedTo, undefined);
});

test("GET /google/callback forwards session save failures", async () => {
  const router = createAuthRouter({
    sanitizeUser: ({ hashedPassword: _hashedPassword, ...user }) => user,
  });
  const layer = router.stack.find((entry) => entry.route?.path === "/google/callback");
  const handler = layer.route.stack.at(-1).handle;
  const req = {
    user: {
      _id: "user-1",
      email: "oauth@example.com",
      role: "tenant",
      banned: false,
    },
    session: {
      regenerate(callback) {
        callback(null);
      },
      save(callback) {
        callback(new Error("oauth session store detail"));
      },
    },
  };
  const res = createResponse();
  let forwardedError;

  await handler(req, res, (error) => {
    forwardedError = error;
  });

  assert.equal(res.payload, undefined);
  assert.equal(res.redirectedTo, undefined);
  assert.ok(forwardedError instanceof Error);
});

test("POST /login rejects demo accounts outside development", async () => {
  const router = createAuthRouter(
    {
      findUserByEmail: async () => ({
        _id: "user-1",
        email: "admin@leaseqa.dev",
        hashedPassword: "hashed-password",
        role: "admin",
        banned: false,
        toObject() {
          return {
            _id: "user-1",
            email: "admin@leaseqa.dev",
            username: "Demo Admin",
            hashedPassword: "hashed-password",
            role: "admin",
            banned: false,
          };
        },
      }),
      verifyPassword: () => true,
    },
    {
      env: {
        SERVER_ENV: "production",
      },
    },
  );
  const handler = getRouteHandler(router, "post", "/login");
  const req = {
    body: {
      email: "admin@leaseqa.dev",
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

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error.code, "INVALID_CREDENTIALS");
  assert.equal(req.session.currentUser, undefined);
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

test("GET /session clears demo sessions outside development", async () => {
  const router = createAuthRouter(undefined, {
    env: {
      SERVER_ENV: "production",
    },
  });
  const handler = getRouteHandler(router, "get", "/session");
  const req = {
    sessionID: "session-1",
    session: {
      currentUser: {
        _id: "user-1",
        email: "admin@leaseqa.dev",
        role: "admin",
      },
      destroy(callback) {
        callback();
      },
    },
  };
  const res = createResponse();

  await handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error.code, "UNAUTHORIZED");
  assert.equal(req.session.currentUser, undefined);
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

const passwordUser = (overrides = {}) => ({
  _id: "user-1",
  email: "tenant@example.com",
  username: "Tenant",
  hashedPassword: "hash-of-old-secret",
  role: "tenant",
  ...overrides,
});

const createPasswordRouter = (user, updates = []) => createAuthRouter({
  findUserById: async () => user,
  verifyPassword: (plain, hash) => hash === "hash-of-old-secret" && plain === "old-secret",
  updatePassword: async (id, password) => {
    updates.push({ id, password });
    return { ...user, hashedPassword: `hash-of-${password}` };
  },
  sanitizeUser: ({ hashedPassword, ...safeUser }) => ({
    ...safeUser,
    hasPassword: Boolean(hashedPassword),
  }),
});

const signedInSession = () => ({
  currentUser: { _id: "user-1", email: "tenant@example.com", role: "tenant" },
  regenerated: false,
  regenerate(callback) {
    this.regenerated = true;
    callback(null);
  },
  save(callback) {
    callback(null);
  },
});

const changePassword = async (router, body, session = signedInSession()) => {
  const handler = getRouteHandler(router, "post", "/password");
  const req = { body, session, sessionID: "session-1" };
  const res = createResponse();
  await handler(req, res);
  return { req, res };
};

test("POST /password stores the new password and starts a fresh session", async () => {
  const updates = [];
  const router = createPasswordRouter(passwordUser(), updates);

  const { req, res } = await changePassword(router, {
    currentPassword: "old-secret",
    newPassword: "new-secret",
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(updates, [{ id: "user-1", password: "new-secret" }]);
  assert.equal(req.session.regenerated, true);
  assert.equal(res.payload.data.hasPassword, true);
  assert.equal("hashedPassword" in res.payload.data, false);
});

test("POST /password refuses a wrong current password and changes nothing", async () => {
  const updates = [];
  const router = createPasswordRouter(passwordUser(), updates);

  const { res } = await changePassword(router, {
    currentPassword: "guess",
    newPassword: "new-secret",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error.code, "INVALID_CURRENT_PASSWORD");
  assert.deepEqual(updates, []);
});

test("POST /password rejects a new password equal to the current one", async () => {
  const updates = [];
  const router = createPasswordRouter(passwordUser(), updates);

  const { res } = await changePassword(router, {
    currentPassword: "old-secret",
    newPassword: "old-secret",
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.error.code, "VALIDATION_ERROR");
  assert.deepEqual(updates, []);
});

test("POST /password tells an account made through Google that it has no password", async () => {
  const router = createPasswordRouter(passwordUser({ hashedPassword: undefined, googleId: "g-1" }));

  const { res } = await changePassword(router, {
    currentPassword: "anything",
    newPassword: "new-secret",
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.payload.error.code, "NO_PASSWORD");
});

test("POST /password keeps the demo accounts' shared password", async () => {
  const updates = [];
  const router = createPasswordRouter(passwordUser({ email: "tenant@leaseqa.dev" }), updates);

  const { res } = await changePassword(router, {
    currentPassword: "old-secret",
    newPassword: "new-secret",
  });

  assert.equal(res.statusCode, 403);
  assert.deepEqual(updates, []);
});

test("POST /password needs a signed-in user and a complete body", async () => {
  const router = createPasswordRouter(passwordUser());

  const signedOut = await changePassword(
    router,
    { currentPassword: "old-secret", newPassword: "new-secret" },
    {},
  );
  assert.equal(signedOut.res.statusCode, 401);

  const incomplete = await changePassword(router, { currentPassword: "old-secret" });
  assert.equal(incomplete.res.statusCode, 400);
  assert.equal(incomplete.res.payload.error.code, "VALIDATION_ERROR");
});
