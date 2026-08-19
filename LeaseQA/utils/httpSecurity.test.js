import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFile } from "node:fs/promises";

import {
  applyHttpSecurity,
  assertProductionSessionConfig,
  buildCorsOptions,
  unexpectedErrorHandler,
} from "./httpSecurity.js";

const isCorsOriginAllowed = (options, origin) => new Promise((resolve) => {
  options.origin(origin, (error, allowed) => resolve(!error && allowed === true));
});

test("CORS permits exact configured origins and rejects arbitrary Vercel subdomains", async () => {
  const options = buildCorsOptions({
    CLIENT_URL: "https://leaseqa-client.vercel.app",
    CORS_ALLOWED_ORIGINS: "https://preview.leaseqa.example, https://admin.leaseqa.example",
  });

  assert.equal(
    await isCorsOriginAllowed(options, "https://leaseqa-client.vercel.app"),
    true,
  );
  assert.equal(
    await isCorsOriginAllowed(options, "https://preview.leaseqa.example"),
    true,
  );
  assert.equal(
    await isCorsOriginAllowed(options, "https://attacker.vercel.app"),
    false,
  );
  assert.equal(options.credentials, true);
});

test("CORS permits requests without an Origin header", async () => {
  const options = buildCorsOptions({ CLIENT_URL: "https://leaseqa-client.vercel.app" });
  assert.equal(await isCorsOriginAllowed(options, undefined), true);
});

test("production rejects missing and placeholder session secrets", () => {
  assert.throws(
    () => assertProductionSessionConfig({ SERVER_ENV: "production" }),
    /SESSION_SECRET/,
  );
  assert.throws(
    () => assertProductionSessionConfig({
      SERVER_ENV: "production",
      SESSION_SECRET: "leaseqa-secret",
    }),
    /SESSION_SECRET/,
  );
  assert.throws(
    () => assertProductionSessionConfig({
      SERVER_ENV: "production",
      SESSION_SECRET: "leaseqa-development-only-secret",
    }),
    /SESSION_SECRET/,
  );
  assert.equal(
    assertProductionSessionConfig({
      SERVER_ENV: "production",
      SESSION_SECRET: "a-production-only-session-secret",
    }),
    "a-production-only-session-secret",
  );
});

test("development receives an explicit local-only session fallback", () => {
  assert.equal(
    assertProductionSessionConfig({ SERVER_ENV: "development" }),
    "leaseqa-development-only-secret",
  );
});

test("HTTP security returns a request ID without leaking unexpected errors", async (t) => {
  const app = express();
  applyHttpSecurity(app, {
    CLIENT_URL: "https://leaseqa-client.vercel.app",
  });
  app.get("/failure", () => {
    throw new Error(`database-password process-${process.version}`);
  });
  app.use(unexpectedErrorHandler);

  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...values) => logged.push(values.join(" "));
  t.after(() => {
    console.error = originalConsoleError;
  });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/failure`, {
    headers: { Origin: "https://leaseqa-client.vercel.app" },
  });
  const payload = await response.json();
  const serialized = JSON.stringify(payload);

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), "https://leaseqa-client.vercel.app");
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal(payload.error.code, "INTERNAL_ERROR");
  assert.equal(payload.error.requestId, response.headers.get("x-request-id"));
  assert.doesNotMatch(serialized, /database-password|process-v|stack/i);
  assert.doesNotMatch(logged.join("\n"), /database-password|process-v|stack/i);
});

test("HTTP security permits cross-origin uploads while keeping API resources same-origin", async (t) => {
  const app = express();
  applyHttpSecurity(app, {
    CLIENT_URL: "https://leaseqa-client.vercel.app",
  });
  app.get("/uploads/example.pdf", (_req, res) => res.send("document"));
  app.get("/api/example", (_req, res) => res.json({ ok: true }));

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  const [uploadResponse, apiResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/uploads/example.pdf`, {
      headers: { Origin: "https://leaseqa-client.vercel.app" },
    }),
    fetch(`http://127.0.0.1:${port}/api/example`, {
      headers: { Origin: "https://leaseqa-client.vercel.app" },
    }),
  ]);

  assert.equal(
    uploadResponse.headers.get("cross-origin-resource-policy"),
    "cross-origin",
  );
  assert.equal(
    apiResponse.headers.get("cross-origin-resource-policy"),
    "same-origin",
  );
});

test("environment template documents the active CORS allowlist variable", async () => {
  const template = await readFile(new URL("../../.env.example", import.meta.url), "utf8");

  assert.match(template, /^CORS_ALLOWED_ORIGINS=<comma-separated-client-origins>$/m);
  assert.doesNotMatch(template, /^CLIENT_URLS=/m);
  assert.match(template, /CLIENT_URLS is deprecated.*CORS_ALLOWED_ORIGINS/);
});
