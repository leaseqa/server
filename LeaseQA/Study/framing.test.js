import test from "node:test";
import assert from "node:assert/strict";

import { getFramingInstructions } from "./framing.js";

test("getFramingInstructions returns a distinct professional personalized instruction block", () => {
  const prompt = getFramingInstructions("professional_personalized");

  assert.match(prompt, /your situation/i);
  assert.match(prompt, /you/i);
  assert.doesNotMatch(prompt, /claim to be a lawyer/i);
});

test("getFramingInstructions returns a distinct informational detached instruction block", () => {
  const prompt = getFramingInstructions("informational_detached");

  assert.match(prompt, /general legal information/i);
  assert.match(prompt, /avoid second-person pronouns/i);
  assert.match(prompt, /do not recommend a concrete next step/i);
  assert.doesNotMatch(prompt, /claim to be a lawyer/i);
});

test("getFramingInstructions falls back to informational detached wording", () => {
  const fallback = getFramingInstructions("unknown-mode");
  const informational = getFramingInstructions("informational_detached");

  assert.equal(fallback, informational);
});
