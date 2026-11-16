import test from "node:test";
import assert from "node:assert/strict";

import { createApplication } from "../app.js";

// The real budgets, not the CI-raised ones: CI_DISABLE_RATE_LIMIT is left unset.
const startApp = async (t, { trustProxy, currentUser } = {}) => {
  const app = createApplication({
    env: { CLIENT_URL: "http://localhost:3000" },
    sessionMiddleware: (req, _res, next) => {
      req.session = currentUser ? { currentUser } : {};
      next();
    },
  });
  // index.js trusts one hop in production; mirroring it lets a test give each
  // request its own address through X-Forwarded-For.
  if ( trustProxy ) app.set("trust proxy", trustProxy);
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

// An empty password fails validation before any database lookup, which is the
// cheapest way to make a failed sign-in attempt.
const failedSignIn = (baseUrl, email, headers = {}) =>
  fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email, password: "" }),
  });

test("the session check a page load makes never spends the sign-in budget", async (t) => {
  const baseUrl = await startApp(t);

  for ( let i = 0; i < 15; i += 1 ) {
    const response = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(response.status, 401, `session check ${i + 1}`);
  }

  const signIn = await failedSignIn(baseUrl, "tenant@example.com");
  assert.equal(signIn.status, 400);
});

test("the eleventh failed attempt on an account gets a 429 the client can read", async (t) => {
  const baseUrl = await startApp(t);

  for ( let i = 0; i < 10; i += 1 ) {
    const response = await failedSignIn(baseUrl, "tenant@example.com");
    assert.equal(response.status, 400, `attempt ${i + 1}`);
  }

  const limited = await failedSignIn(baseUrl, "tenant@example.com");
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.error.code, "RATE_LIMITED");
  assert.match(body.error.message, /15 minutes/);
});

test("one account running out of attempts leaves other accounts alone", async (t) => {
  const baseUrl = await startApp(t);

  for ( let i = 0; i < 11; i += 1 ) {
    await failedSignIn(baseUrl, "tenant@example.com");
  }

  const otherAccount = await failedSignIn(baseUrl, "lawyer@example.com");
  assert.equal(otherAccount.status, 400);
});

test("the budget follows the account, whatever address the attempts come from", async (t) => {
  const baseUrl = await startApp(t, { trustProxy: 1 });

  for ( let i = 0; i < 10; i += 1 ) {
    // Case and whitespace in the email do not buy a fresh budget either.
    const email = i % 2 ? "Tenant@Example.com " : "tenant@example.com";
    const response = await failedSignIn(baseUrl, email, {
      "X-Forwarded-For": `203.0.113.${i + 1}`,
    });
    assert.equal(response.status, 400, `attempt ${i + 1}`);
  }

  const limited = await failedSignIn(baseUrl, "tenant@example.com", {
    "X-Forwarded-For": "203.0.113.200",
  });
  assert.equal(limited.status, 429);
});

test("every limiter answers in the API's JSON error shape", async (t) => {
  const baseUrl = await startApp(t);

  let response;
  for ( let i = 0; i < 101; i += 1 ) {
    response = await fetch(`${baseUrl}/api/folders/not-a-route`);
  }

  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.code, "RATE_LIMITED");
  assert.match(body.error.message, /Wait a minute/);
});

test("password change attempts count against the signed-in user", async (t) => {
  const baseUrl = await startApp(t, {
    currentUser: { _id: "user-1", email: "tenant@example.com", role: "tenant" },
  });
  // An empty body fails validation after the session check, before any lookup.
  const attempt = () => fetch(`${baseUrl}/api/auth/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  for ( let i = 0; i < 10; i += 1 ) {
    const response = await attempt();
    assert.equal(response.status, 400, `attempt ${i + 1}`);
  }

  const limited = await attempt();
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "RATE_LIMITED");
});
