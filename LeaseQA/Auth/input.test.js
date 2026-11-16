import test from "node:test";
import assert from "node:assert/strict";

import {
  parseLogin,
  parsePasswordChange,
  parseProfileUpdate,
  parseRegistration,
} from "./input.js";

test("parsePasswordChange needs both passwords and nothing else", () => {
  assert.deepEqual(
    parsePasswordChange({ currentPassword: "old-secret", newPassword: "new-secret" }),
    { currentPassword: "old-secret", newPassword: "new-secret" },
  );
  assert.throws(() => parsePasswordChange({ newPassword: "new-secret" }));
  assert.throws(() => parsePasswordChange({ currentPassword: "old-secret", newPassword: "" }));
  assert.throws(
    () => parsePasswordChange({
      currentPassword: "old-secret",
      newPassword: "new-secret",
      email: "tenant@example.com",
    }),
    /Unrecognized key/,
  );
});

test("parseRegistration normalizes public fields and forces tenant role", () => {
  assert.deepEqual(
    parseRegistration({
      username: "  Fresh Tenant  ",
      email: "  FRESH@Example.COM ",
      password: "leaseqa-secret",
      role: "admin",
      lawyerVerification: { barNumber: "x", state: "MA" },
    }),
    {
      username: "Fresh Tenant",
      email: "fresh@example.com",
      password: "leaseqa-secret",
      role: "tenant",
    },
  );
});

test("parseLogin normalizes email and rejects unknown fields", () => {
  assert.deepEqual(
    parseLogin({
      email: "  TENANT@Example.COM ",
      password: "leaseqa-secret",
    }),
    {
      email: "tenant@example.com",
      password: "leaseqa-secret",
    },
  );
  assert.throws(
    () => parseLogin({
      email: "tenant@example.com",
      password: "leaseqa-secret",
      role: "admin",
    }),
    /Unrecognized key/,
  );
});

test("parseProfileUpdate accepts only normalized username and avatarUrl", () => {
  assert.deepEqual(
    parseProfileUpdate({
      username: "  Renamed Tenant  ",
      avatarUrl: "https://cdn.example.com/avatar.png",
    }),
    {
      username: "Renamed Tenant",
      avatarUrl: "https://cdn.example.com/avatar.png",
    },
  );
  assert.throws(() => parseProfileUpdate({ role: "admin" }), /Unrecognized key/);
});

test("input parsers reject malformed required values", () => {
  assert.throws(
    () => parseRegistration({ username: " ", email: "not-email", password: "" }),
  );
  assert.throws(() => parseLogin({ email: "not-email", password: "" }));
  assert.throws(() => parseProfileUpdate({ avatarUrl: "not-a-url" }));
});
