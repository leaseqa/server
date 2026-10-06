import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getRagConfig } from "../LeaseQA/RAG/config.js";
import {
  matchesExpectation,
  normalizeChunkExpectationInput,
} from "../LeaseQA/RAG/evalExpectations.js";
import { createRerankClient } from "../LeaseQA/RAG/rerank.js";
import {
  buildRetrievalQuestion,
  rankEvidence,
  selectEvidence,
} from "../LeaseQA/RAG/retrievalPolicy.js";
import {
  createEmbeddingsClient,
  retrieveKnowledgeCandidates,
} from "../LeaseQA/RAG/service.js";
import { EVAL_PLACEHOLDER_SOURCE_TEXT } from "./run-rag-eval.js";

// For every eval case, how its evidence ranks under the live provider: the
// reranker's score for the best chunk and for the first chunk from the expected
// source, and whether that chunk reaches the model. RAG_MIN_RERANK_SCORE
// belongs above every out-of-scope case's best score and below every
// answerable case's expected-source score; the summary prints that window.
// Retrieval only: no server, no database, no chat model.

const evalSetPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "LeaseQA",
  "RAG",
  "evals",
  "tenant-rights-eval.json",
);

// The one session chunk the eval's session holds. Its fused score is what the
// session search gives a single chunk: both rankers when the question shares
// words with an upload, the dense ranker alone for the placeholder.
const sessionChunkFor = (evalCase) => {
  const upload = evalCase.upload;
  if ( upload && upload.content != null ) {
    const sourceName = upload.sourceName || "uploaded-document.txt";
    return {
      id: `session:${evalCase.id}`,
      source_group: "upload",
      source_name: sourceName,
      title_hint: sourceName,
      chapter_ref: "",
      text: String(upload.content),
      score: 2 / 61,
    };
  }
  return {
    id: `session:${evalCase.id}`,
    source_group: "text",
    source_name: "pasted-text",
    title_hint: "pasted-text",
    chapter_ref: "",
    text: EVAL_PLACEHOLDER_SOURCE_TEXT,
    score: 1 / 61,
  };
};

const label = (chunk) =>
  `${chunk.source_group}/${chunk.source_name}${chunk.chapter_ref ? `#${chunk.chapter_ref}` : ""}`;

const formatScore = (value) =>
  Number.isFinite(value) ? value.toFixed(3) : "n/a";

const isExpected = (evalCase, chunk) =>
  matchesExpectation(evalCase, normalizeChunkExpectationInput(chunk));

export const reportCase = async ({ evalCase, config, embeddings, rerankClient }) => {
  const sessionChunk = sessionChunkFor(evalCase);
  const question = buildRetrievalQuestion({
    question: evalCase.question,
    sourceTextPreview: sessionChunk.text,
    messages: [],
  });
  const vector = await embeddings.embedQuery(question);
  const candidates = await retrieveKnowledgeCandidates({ config, vector, question });
  const chunks = [sessionChunk, ...candidates];

  let rerankFailure = null;
  const reranked = await rankEvidence({
    question,
    chunks,
    rerankClient,
    onRerankError: (error) => {
      rerankFailure = error?.code || "RAG_RERANK_FAILED";
    },
  });
  const fused = await rankEvidence({ question, chunks, rerankClient: null });
  const evidence = selectEvidence({ ranking: reranked, config });
  const fusedEvidence = selectEvidence({ ranking: fused, config });

  const expectedRank = evalCase.expectAbstain
    ? -1
    : reranked.chunks.findIndex((chunk) => isExpected(evalCase, chunk));
  return {
    id: evalCase.id,
    expectAbstain: Boolean(evalCase.expectAbstain),
    rankedBy: reranked.rankedBy,
    rerankFailure,
    candidates: chunks.length,
    bestScore: reranked.chunks[0]?.rerank_score ?? null,
    expectedRank,
    expectedScore:
      expectedRank >= 0 ? reranked.chunks[expectedRank].rerank_score : null,
    reachesModel: evalCase.expectAbstain
      ? evidence.length === 0
      : evidence.some((chunk) => isExpected(evalCase, chunk)),
    reachesModelWithoutRerank: evalCase.expectAbstain
      ? fusedEvidence.length === 0
      : fusedEvidence.some((chunk) => isExpected(evalCase, chunk)),
    top: reranked.chunks.slice(0, 4).map((chunk) => ({
      label: label(chunk),
      score: chunk.rerank_score,
    })),
  };
};

const printCase = (result, minRerankScore) => {
  const expectation = result.expectAbstain
    ? `abstain: ${result.reachesModel ? "yes" : "NO"}`
    : `expected #${result.expectedRank + 1 || "-"} at ${formatScore(result.expectedScore)}, reaches model: ${result.reachesModel ? "yes" : "NO"}`;
  console.log(
    `${result.id}  best ${formatScore(result.bestScore)}  ${expectation}` +
      `  (fused order: ${result.reachesModelWithoutRerank ? "ok" : "miss"})` +
      (result.rankedBy === "rerank" ? "" : `  RERANK UNAVAILABLE ${result.rerankFailure || ""}`),
  );
  result.top.forEach((item, index) => {
    const marker = item.score >= minRerankScore ? " " : "-";
    console.log(`  ${marker}${index + 1}. ${formatScore(item.score)}  ${item.label}`);
  });
};

const printSummary = (results, minRerankScore) => {
  const answerable = results.filter((result) => !result.expectAbstain);
  const outOfScope = results.filter((result) => result.expectAbstain);
  const count = (items, key) => items.filter((item) => item[key]).length;
  const lowestExpected = answerable
    .filter((result) => result.expectedScore !== null)
    .sort((left, right) => left.expectedScore - right.expectedScore)[0];
  const highestOutOfScope = [...outOfScope]
    .filter((result) => result.bestScore !== null)
    .sort((left, right) => right.bestScore - left.bestScore)[0];

  console.log("");
  console.log(`RAG_MIN_RERANK_SCORE=${minRerankScore}`);
  console.log(
    `answerable: expected source reaches the model in ${count(answerable, "reachesModel")}/${answerable.length}` +
      ` (fused order without rerank: ${count(answerable, "reachesModelWithoutRerank")}/${answerable.length});` +
      ` never retrieved: ${answerable.filter((result) => result.expectedRank < 0).map((result) => result.id).join(", ") || "none"}`,
  );
  console.log(
    `out of scope: abstains in ${count(outOfScope, "reachesModel")}/${outOfScope.length}` +
      ` (fused order without rerank: ${count(outOfScope, "reachesModelWithoutRerank")}/${outOfScope.length})`,
  );
  if ( lowestExpected && highestOutOfScope ) {
    const low = highestOutOfScope.bestScore;
    const high = lowestExpected.expectedScore;
    console.log(
      `floor window: above ${formatScore(low)} (${highestOutOfScope.id}) and at or below ${formatScore(high)} (${lowestExpected.id})` +
        (low < high ? "" : "  -- NO SINGLE FLOOR SEPARATES THESE"),
    );
  }
};

export const main = async ({ ids = null } = {}) => {
  const config = getRagConfig();
  const embeddings = createEmbeddingsClient(config);
  const rerankClient = createRerankClient(config);
  const evalCases = JSON.parse(await fs.readFile(evalSetPath, "utf8")).filter(
    (evalCase) => !ids || ids.includes(evalCase.id),
  );
  if ( !rerankClient ) {
    console.log("Reranking is off for this provider; showing the fused order only.");
  }

  const results = [];
  for ( const evalCase of evalCases ) {
    try {
      const result = await reportCase({ evalCase, config, embeddings, rerankClient });
      results.push(result);
      printCase(result, config.minRerankScore);
    } catch ( error ) {
      console.log(`${evalCase.id}  FAILED ${error?.code || error?.name || "error"}`);
    }
  }
  printSummary(results, config.minRerankScore);
  return results.length === evalCases.length ? 0 : 1;
};

if ( process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href ) {
  const idsArgument = process.argv
    .slice(2)
    .find((argument) => argument.startsWith("--ids="));
  main({
    ids: idsArgument
      ? idsArgument.slice("--ids=".length).split(",").map((id) => id.trim())
      : null,
  })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error?.code || error?.message || "report failed");
      process.exitCode = 1;
    });
}
