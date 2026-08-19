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

test("POST /register returns the internal-error envelope when regeneration fails", async () => {
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

  await handler(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(res.payload), /session backend unavailable/);
});

test("POST /login returns the internal-error envelope when session save fails", async () => {
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

  await handler(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.payload.error.code, "INTERNAL_ERROR");
  assert.doesNotMatch(JSON.stringify(res.payload), /session write detail/);
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
