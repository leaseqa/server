import test from "node:test";
import assert from "node:assert/strict";

import { parseArguments } from "../../scripts/ingest-rag-corpus.js";

// npm run ingest:rag is the one command on this branch that spends the
// embedding budget and repoints the production alias, so every argument it
// misreads is expensive. The four sibling CLIs (corpus:check, corpus:refresh,
// the manifest migration, the issue formatter) all throw on an unknown
// argument; these tests pin the same contract here.

test("a space instead of = is refused rather than silently ingesting everything", () => {
  // `npm run ingest:rag -- --limit 5` is the smoke test an operator reaches
  // for. Dropping the two words used to ingest all 81 files, run the gate and
  // repoint the alias.
  assert.throws(() => parseArguments(["--limit", "5"]), /Unknown argument: --limit/);
  assert.throws(
    () => parseArguments(["--min-hit-rate", "0.5"]),
    /Unknown argument: --min-hit-rate/,
  );
});

test("an unknown or misspelled flag is refused", () => {
  assert.throws(() => parseArguments(["--rest"]), /Unknown argument: --rest/);
  assert.throws(() => parseArguments(["--no-gates"]), /Unknown argument: --no-gates/);
  assert.throws(() => parseArguments(["-r"]), /Unknown argument: -r/);
});

test("--min-hit-rate outside 0..1 is refused instead of being discarded", () => {
  // 95 is someone typing a percentage. Discarding it left the run gating at
  // the 0.9 default while the operator believed they had asked for 95%.
  assert.throws(() => parseArguments(["--min-hit-rate=95"]), /--min-hit-rate/);
  assert.throws(() => parseArguments(["--min-hit-rate=-0.1"]), /--min-hit-rate/);
  assert.throws(() => parseArguments(["--min-hit-rate=abc"]), /--min-hit-rate/);
  assert.throws(() => parseArguments(["--min-hit-rate="]), /--min-hit-rate/);
});

test("--limit that is not a positive integer is refused instead of being discarded", () => {
  assert.throws(() => parseArguments(["--limit=0"]), /--limit/);
  assert.throws(() => parseArguments(["--limit=-3"]), /--limit/);
  assert.throws(() => parseArguments(["--limit=all"]), /--limit/);
  assert.throws(() => parseArguments(["--limit="]), /--limit/);
});

test("the supported flags still parse", () => {
  assert.deepEqual(parseArguments([]), {
    help: false,
    reset: false,
    limit: null,
    gate: true,
    minHitRate: null,
  });
  assert.deepEqual(
    parseArguments(["--reset", "--no-gate", "--min-hit-rate=0.75", "--limit=5"]),
    {
      help: false,
      reset: true,
      limit: 5,
      gate: false,
      minHitRate: 0.75,
    },
  );
  // The gate boundaries are legal values, not out-of-range ones.
  assert.equal(parseArguments(["--min-hit-rate=0"]).minHitRate, 0);
  assert.equal(parseArguments(["--min-hit-rate=1"]).minHitRate, 1);
});

test("--help is a supported flag and does not ingest anything", () => {
  assert.equal(parseArguments(["--help"]).help, true);
  assert.equal(parseArguments(["-h"]).help, true);
});
