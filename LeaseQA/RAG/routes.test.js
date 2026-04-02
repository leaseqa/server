import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSessionStudyMetadata,
  getUploadMaxBytes,
  normalizeResponseFraming,
} from "./routes.js";

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

test("buildSessionStudyMetadata returns null when no experiment metadata is provided", () => {
  assert.equal(buildSessionStudyMetadata({}), null);
});

test("buildSessionStudyMetadata preserves participant and condition metadata", () => {
  assert.deepEqual(
    buildSessionStudyMetadata({
      participantId: "R_123",
      conditionId: "C3",
      scenarioId: "security-deposit",
      responseFraming: "professional_personalized",
    }),
    {
      studyParticipantId: "R_123",
      studyConditionId: "C3",
      studyScenarioId: "security-deposit",
      studyFraming: "professional_personalized",
    },
  );
});
