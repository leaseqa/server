import test from "node:test";
import assert from "node:assert/strict";

import { RAG_READ_LIMIT, RAG_WRITE_LIMIT, isRagRead } from "./rateLimits.js";

test("reads and writes are budgeted apart", () => {
  assert.ok(
    RAG_READ_LIMIT.max > RAG_WRITE_LIMIT.max,
    "polling reads cost nothing and must not compete with generation",
  );
});

test("a review plus follow-ups fits inside the write budget", () => {
  // Creating the session, then three follow-up questions.
  const writesForOneReview = 1 + 3;
  // A user should be able to do several reviews in an hour, not one.
  assert.ok(
    RAG_WRITE_LIMIT.max >= writesForOneReview * 4,
    `write budget ${RAG_WRITE_LIMIT.max} is too tight for repeated use`,
  );
});

test("indexing polls fit inside the read budget", () => {
  // useRagSession polls every 2s while a session indexes, and indexing has
  // measured around 20s, so one review can spend a dozen reads on its own.
  const readsForOneReview = 1 + Math.ceil(20_000 / 2_000) + 1;
  assert.ok(
    RAG_READ_LIMIT.max >= readsForOneReview * 10,
    `read budget ${RAG_READ_LIMIT.max} leaves no room for polling`,
  );
});

test("only safe methods count as reads", () => {
  for ( const method of ["GET", "HEAD", "OPTIONS"] ) {
    assert.equal(isRagRead(method), true, `${method} should be a read`);
  }
  for ( const method of ["POST", "PUT", "PATCH", "DELETE"] ) {
    assert.equal(isRagRead(method), false, `${method} should be a write`);
  }
});
