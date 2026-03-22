import test from "node:test";
import assert from "node:assert/strict";

import { getUploadMaxBytes, normalizeResponseFraming } from "./routes.js";

test("getUploadMaxBytes defaults to 20MB", () => {
  assert.equal(getUploadMaxBytes({}), 20 * 1024 * 1024);
});

test("getUploadMaxBytes respects explicit env overrides", () => {
  assert.equal(
    getUploadMaxBytes({ RAG_UPLOAD_MAX_BYTES: `${15 * 1024 * 1024}` }),
    15 * 1024 * 1024,
  );
});

test("normalizeResponseFraming falls back to informational_detached", () => {
  assert.equal(
    normalizeResponseFraming(undefined),
    "informational_detached",
  );
  assert.equal(
    normalizeResponseFraming("professional_personalized"),
    "professional_personalized",
  );
});
