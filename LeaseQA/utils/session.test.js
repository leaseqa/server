import test from "node:test";
import assert from "node:assert/strict";

import { requireRole, requireUser } from "./session.js";

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

test("requireUser rejects demo sessions outside development", () => {
  const req = {
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

  const currentUser = requireUser(req, res, {
    env: {
      SERVER_ENV: "production",
    },
  });

  assert.equal(currentUser, null);
  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error.code, "UNAUTHORIZED");
  assert.equal(req.session.currentUser, undefined);
});

test("requireRole keeps non-demo admins available outside development", () => {
  const req = {
    session: {
      currentUser: {
        _id: "user-1",
        email: "real-admin@example.com",
        role: "admin",
      },
    },
  };
  const res = createResponse();

  const currentUser = requireRole(req, res, ["admin"], {
    env: {
      SERVER_ENV: "production",
    },
  });

  assert.deepEqual(currentUser, req.session.currentUser);
  assert.equal(res.payload, undefined);
});
