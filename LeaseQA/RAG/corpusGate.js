import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  matchesExpectation,
  normalizeChunkExpectationInput,
  pastedSourceTextOf,
} from "./evalExpectations.js";

const defaultEvalSetPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "evals",
  "tenant-rights-eval.json",
);

export const loadGateCases = async ({
  evalSetPath = defaultEvalSetPath,
  readFileFn = fs.readFile,
} = {}) => {
  const raw = await readFileFn(evalSetPath, "utf8");
  // Retrieval cannot judge an abstain case, and a pasted-text case asks about
  // "this clause", which means nothing without its session. Upload cases have
  // the same problem but stay: they already count as misses here, and dropping
  // them would loosen min_hit_rate.
  return JSON.parse(raw).filter(
    (evalCase) => !evalCase.expectAbstain && pastedSourceTextOf(evalCase) === null,
  );
};

const runCase = async ({ evalCase, collectionName, embedQuery, retrieveChunks }) => {
  let chunks;
  try {
    const vector = await embedQuery(evalCase.question);
    chunks = await retrieveChunks({
      collectionName,
      vector,
      question: evalCase.question,
    });
  } catch ( error ) {
    console.error(
      JSON.stringify({
        event: "rag_gate_case_failed",
        caseId: evalCase.id,
        errorCode: error?.code || "RAG_GATE_RETRIEVAL_ERROR",
        providerStatus: error?.status ?? null,
        providerReason: error?.providerReason ?? null,
      }),
    );
    chunks = [];
  }

  const candidates = (chunks || []).map(normalizeChunkExpectationInput);
  const hit = candidates.some((candidate) =>
    matchesExpectation(evalCase, candidate),
  );

  return {
    hit,
    miss: hit
      ? null
      : {
          id: evalCase.id,
          expectedSourceGroup: evalCase.expectedSourceGroup,
          actualSourceGroups: [
            ...new Set(
              candidates.map((candidate) => candidate.sourceGroup).filter(Boolean),
            ),
          ],
        },
  };
};

const inBatches = async (items, size, worker) => {
  const output = [];
  for ( let index = 0; index < items.length; index += size ) {
    const batch = items.slice(index, index + size);
    output.push(...(await Promise.all(batch.map(worker))));
  }
  return output;
};

export const runRetrievalGate = async ({
  evalCases,
  collectionName,
  embedQuery,
  retrieveChunks,
  minHitRate = 0.9,
  concurrency = 4,
}) => {
  const results = await inBatches(evalCases, concurrency, (evalCase) =>
    runCase({ evalCase, collectionName, embedQuery, retrieveChunks }),
  );

  const hits = results.filter((result) => result.hit).length;
  const total = results.length;
  const hitRate = total === 0 ? 0 : hits / total;

  return {
    passed: total > 0 && hitRate >= minHitRate,
    collectionName,
    minHitRate,
    hitRate,
    total,
    hits,
    misses: results.map((result) => result.miss).filter(Boolean),
  };
};
