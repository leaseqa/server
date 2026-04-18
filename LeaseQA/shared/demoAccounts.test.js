import test from "node:test";
import assert from "node:assert/strict";

import {
  areDemoAccountsAllowed,
  assertDemoAccountsAllowed,
  isBlockedDemoAccount,
  isDemoAccountEmail,
} from "./demoAccounts.js";

test("isDemoAccountEmail matches reserved demo emails case-insensitively", () => {
  assert.equal(isDemoAccountEmail("Admin@LeaseQA.dev"), true);
  assert.equal(isDemoAccountEmail("real-user@example.com"), false);
});

test("areDemoAccountsAllowed defaults to local development-friendly behavior", () => {
  assert.equal(areDemoAccountsAllowed({}), true);
  assert.equal(areDemoAccountsAllowed({ NODE_ENV: "test" }), true);
  assert.equal(areDemoAccountsAllowed({ SERVER_ENV: "development" }), true);
});

test("isBlockedDemoAccount disables reserved demo emails in production-like envs", () => {
  assert.equal(
    isBlockedDemoAccount("admin@leaseqa.dev", { SERVER_ENV: "production" }),
    true,
  );
  assert.equal(
    isBlockedDemoAccount("admin@leaseqa.dev", { SERVER_ENV: "production", ALLOW_DEMO_ACCOUNTS: "true" }),
    false,
  );
  assert.equal(
    isBlockedDemoAccount("real-user@example.com", { SERVER_ENV: "production" }),
    false,
  );
});

test("assertDemoAccountsAllowed throws in production-like envs without override", () => {
  assert.throws(
    () => assertDemoAccountsAllowed({ SERVER_ENV: "production" }),
    /Demo accounts are disabled outside development/,
  );
});
