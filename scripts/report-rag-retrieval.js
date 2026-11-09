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
import { createTextPreview } from "../LeaseQA/RAG/text.js";
import {
  EVAL_PLACEHOLDER_SOURCE_TEXT,
  evalSessionSourceText,
} from "./run-rag-eval.js";

// For every eval case, how its evidence ranks under the live provider: the
// best chunk's score, where the first chunk from the expected source lands,
// and whether the model gets to see it. RAG_MIN_RERANK_SCORE belongs above
// every out-of-scope case's best score and at or below every answerable
// case's; the summary prints that window. Retrieval only: no server, no
// database, no chat model.

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
// words with the case's own upload or pasted text, the dense ranker alone for
// the placeholder.
export const sessionChunkFor = (evalCase) => {
  const upload = evalCase.upload;
  if ( upload && upload.content != null ) {
    const sourceName = upload.sourceName || "uploaded-document.txt";
    return {
      source_group: "upload",
      source_name: sourceName,
      title_hint: sourceName,
      chapter_ref: "",
      text: String(upload.content),
      score: 2 / 61,
    };
  }
  const text = evalSessionSourceText(evalCase);
  return {
    source_group: "text",
    source_name: "pasted-text",
    title_hint: "pasted-text",
    chapter_ref: "",
    text,
    score: text === EVAL_PLACEHOLDER_SOURCE_TEXT ? 1 / 61 : 2 / 61,
  };
};

const label = (chunk) =>
  `${chunk.source_group}/${chunk.source_name}${chunk.chapter_ref ? `#${chunk.chapter_ref}` : ""}`;

const scoreOf = (ranking, chunk) =>
  ranking.rankedBy === "rerank" ? chunk.rerank_score : chunk.score;

const formatScore = (value) =>
  Number.isFinite(value) ? value.toFixed(3) : "n/a";

const isExpected = (evalCase, chunk) =>
  matchesExpectation(evalCase, normalizeChunkExpectationInput(chunk));

const reachesModel = (evalCase, evidence) =>
  evalCase.expectAbstain
    ? evidence.length === 0
    : evidence.some((chunk) => isExpected(evalCase, chunk));

export const reportCase = async ({ evalCase, config, embeddings, rerankClient }) => {
  const sessionChunk = sessionChunkFor(evalCase);
  // The server keeps only this preview of the session text, and that is what
  // a question about "this clause" carries into retrieval.
  const question = buildRetrievalQuestion({
    question: evalCase.question,
    sourceTextPreview: createTextPreview(sessionChunk.text),
    messages: [],
  });
  const vector = await embeddings.embedQuery(question);
  const candidates = await retrieveKnowledgeCandidates({ config, vector, question });
  const chunks = [sessionChunk, ...candidates];

  let rerankFailure = null;
  const ranking = await rankEvidence({
    question,
    chunks,
    rerankClient,
    onRerankError: (error) => {
      rerankFailure = error?.code || "RAG_RERANK_FAILED";
    },
  });
  const fused = await rankEvidence({ question, chunks, rerankClient: null });
  const scores = ranking.chunks.map((chunk) => scoreOf(ranking, chunk));
  const expectedRank = evalCase.expectAbstain
    ? -1
    : ranking.chunks.findIndex((chunk) => isExpected(evalCase, chunk));

  return {
    id: evalCase.id,
    expectAbstain: Boolean(evalCase.expectAbstain),
    rankedBy: ranking.rankedBy,
    rerankFailure,
    candidates: chunks.length,
    bestScore: scores[0] ?? null,
    lowestScore: scores.length ? Math.min(...scores) : null,
    expectedRank,
    expectedScore: expectedRank >= 0 ? scores[expectedRank] : null,
    reachesModel: reachesModel(evalCase, selectEvidence({ ranking, config })),
    reachesModelWithoutRerank: reachesModel(
      evalCase,
      selectEvidence({ ranking: fused, config }),
    ),
    top: ranking.chunks.slice(0, config.evidenceLimit).map((chunk) => ({
      label: label(chunk),
      score: scoreOf(ranking, chunk),
      expected: !evalCase.expectAbstain && isExpected(evalCase, chunk),
    })),
  };
};

const printCase = (result) => {
  const outcome = result.expectAbstain
    ? `abstains: ${result.reachesModel ? "yes" : "NO"}`
    : `expected #${result.expectedRank >= 0 ? result.expectedRank + 1 : "-"}` +
      ` at ${formatScore(result.expectedScore)}, reaches model: ${result.reachesModel ? "yes" : "NO"}`;
  console.log(
    `${result.id}  best ${formatScore(result.bestScore)}` +
      ` (lowest ${formatScore(result.lowestScore)} of ${result.candidates})  ${outcome}` +
      `  [fused order: ${result.reachesModelWithoutRerank ? "ok" : "miss"}]` +
      (result.rankedBy === "rerank" ? "" : `  RERANK UNAVAILABLE ${result.rerankFailure || ""}`),
  );
  result.top.forEach((item, index) => {
    console.log(
      `  ${item.expected ? "*" : " "}${index + 1}. ${formatScore(item.score)}  ${item.label}`,
    );
  });
};

const printSummary = (results, config) => {
  const answerable = results.filter((result) => !result.expectAbstain);
  const outOfScope = results.filter((result) => result.expectAbstain);
  const count = (items, key) => items.filter((item) => item[key]).length;
  const ids = (items) => items.map((item) => item.id).join(", ") || "none";
  const byBest = (items) =>
    [...items]
      .filter((item) => Number.isFinite(item.bestScore))
      .sort((left, right) => left.bestScore - right.bestScore);
  const weakestAnswerable = byBest(answerable)[0];
  const strongestOutOfScope = byBest(outOfScope).at(-1);

  console.log("");
  console.log(
    `RAG_MIN_RERANK_SCORE=${config.minRerankScore}  RAG_CANDIDATES_PER_GROUP=${config.candidatesPerGroup}` +
      `  RAG_EVIDENCE_LIMIT=${config.evidenceLimit}`,
  );
  console.log(
    `answerable: expected source reaches the model in ${count(answerable, "reachesModel")}/${answerable.length}` +
      ` (fused order without rerank: ${count(answerable, "reachesModelWithoutRerank")}/${answerable.length})`,
  );
  console.log(`  misses: ${ids(answerable.filter((item) => !item.reachesModel))}`);
  console.log(
    `  below the floor, so they abstain: ${ids(answerable.filter((item) => !(item.bestScore >= config.minRerankScore)))}`,
  );
  console.log(
    `  expected source never retrieved: ${ids(answerable.filter((item) => item.expectedRank < 0))}`,
  );
  console.log(
    `out of scope: abstains in ${count(outOfScope, "reachesModel")}/${outOfScope.length}` +
      ` (fused order without rerank: ${count(outOfScope, "reachesModelWithoutRerank")}/${outOfScope.length});` +
      ` answers anyway: ${ids(outOfScope.filter((item) => !item.reachesModel))}`,
  );
  if ( weakestAnswerable && strongestOutOfScope ) {
    const low = strongestOutOfScope.bestScore;
    const high = weakestAnswerable.bestScore;
    console.log(
      `floor window on the best score: above ${formatScore(low)} (${strongestOutOfScope.id})` +
        ` and at or below ${formatScore(high)} (${weakestAnswerable.id})` +
        (low < high ? "" : "  -- NO SINGLE FLOOR SEPARATES THESE"),
    );
  }
};

export const parseReportArgs = (argv) => {
  const options = { ids: null, candidatesPerGroup: null };
  argv.forEach((argument) => {
    if ( argument.startsWith("--ids=") ) {
      options.ids = argument
        .slice("--ids=".length)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    }
    if ( argument.startsWith("--candidates-per-group=") ) {
      const value = Number.parseInt(argument.slice("--candidates-per-group=".length), 10);
      options.candidatesPerGroup = Number.isInteger(value) && value > 0 ? value : null;
    }
  });
  return options;
};

export const main = async (argv = process.argv.slice(2)) => {
  const options = parseReportArgs(argv);
  const baseConfig = getRagConfig();
  const config = options.candidatesPerGroup
    ? { ...baseConfig, candidatesPerGroup: options.candidatesPerGroup }
    : baseConfig;
  const embeddings = createEmbeddingsClient(config);
  const rerankClient = createRerankClient(config);
  const evalCases = JSON.parse(await fs.readFile(evalSetPath, "utf8")).filter(
    (evalCase) => !options.ids || options.ids.includes(evalCase.id),
  );
  if ( !rerankClient ) {
    console.log("Reranking is off for this provider; showing the fused order only.");
  }

  const results = [];
  for ( const evalCase of evalCases ) {
    try {
      const result = await reportCase({ evalCase, config, embeddings, rerankClient });
      results.push(result);
      printCase(result);
    } catch ( error ) {
      console.log(`${evalCase.id}  FAILED ${error?.code || error?.name || "error"}`);
    }
  }
  printSummary(results, config);
  return results.length === evalCases.length ? 0 : 1;
};

if ( process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href ) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error?.code || error?.message || "report failed");
      process.exitCode = 1;
    });
}
