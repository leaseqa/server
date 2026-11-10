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
  bestHandbookScore,
  buildRetrievalQuestion,
  needsScopeCheck,
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
// and whether the model gets to see it. The summary prints where the two
// bounds belong. RAG_MIN_RERANK_SCORE goes at or below every answerable case's
// best score and above every other case that must abstain, since the scope
// check stops only out-of-scope questions. RAG_SCOPE_CHECK_BELOW goes above
// every out-of-scope case's best handbook score, which is what the serving
// path holds it against. Retrieval only: no server, no database, no chat
// model. So a case in the band is reported as the scope check's to decide,
// and its evidence as the first ranking's: once the check says yes, the
// serving path ranks the candidates again with the check's search query. The
// live eval runs both.

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

const OUT_OF_SCOPE = "out-of-scope";

// What the serving path does with this ranking before any answer is written.
const gateOf = ({ ranking, config }) => {
  if ( selectEvidence({ ranking, config }).length === 0 ) {
    return "abstains";
  }
  return needsScopeCheck({ ranking, config }) ? "scope check" : "answers";
};

// A case that must abstain does, provided the scope check says no to every
// out-of-scope question in the band. Nothing stops another such case, like a
// tenant question the handbook cannot support, but the floor.
const abstainsAsExpected = (evalCase, gate) =>
  gate === "abstains" || (gate === "scope check" && evalCase.category === OUT_OF_SCOPE);

export const reportCase = async ({ evalCase, config, embeddings, rerankClient, listCount = null }) => {
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
  const gate = gateOf({ ranking, config });

  return {
    id: evalCase.id,
    category: evalCase.category,
    expectAbstain: Boolean(evalCase.expectAbstain),
    gate,
    abstains: abstainsAsExpected(evalCase, gate),
    rankedBy: ranking.rankedBy,
    rerankFailure,
    candidates: chunks.length,
    bestScore: scores[0] ?? null,
    // What the scope-check bound is held against: the best chunk may be the
    // case's own upload or pasted text.
    handbookScore: ranking.rankedBy === "rerank" ? bestHandbookScore(ranking) : null,
    lowestScore: scores.length ? Math.min(...scores) : null,
    expectedRank,
    expectedScore: expectedRank >= 0 ? scores[expectedRank] : null,
    reachesModel: reachesModel(evalCase, selectEvidence({ ranking, config })),
    reachesModelWithoutRerank: reachesModel(
      evalCase,
      selectEvidence({ ranking: fused, config }),
    ),
    evidenceLimit: config.evidenceLimit,
    top: ranking.chunks.slice(0, listCount ?? config.evidenceLimit).map((chunk) => ({
      label: label(chunk),
      score: scoreOf(ranking, chunk),
      expected: !evalCase.expectAbstain && isExpected(evalCase, chunk),
      preview: listCount ? String(chunk.text || "").replace(/\s+/g, " ").trim().slice(0, 90) : null,
    })),
  };
};

const printCase = (result) => {
  const outcome = result.expectAbstain
    ? `abstains: ${result.abstains ? "yes" : "NO"} (${result.gate})`
    : `expected #${result.expectedRank >= 0 ? result.expectedRank + 1 : "-"}` +
      ` at ${formatScore(result.expectedScore)}, reaches model: ${result.reachesModel ? "yes" : "NO"}` +
      (result.gate === "scope check" ? " after the scope check" : "");
  console.log(
    `${result.id}  best ${formatScore(result.bestScore)}` +
      (result.handbookScore !== null && result.handbookScore !== result.bestScore
        ? `, handbook ${formatScore(result.handbookScore)}`
        : "") +
      ` (lowest ${formatScore(result.lowestScore)} of ${result.candidates})  ${outcome}` +
      `  [fused order: ${result.reachesModelWithoutRerank ? "ok" : "miss"}]` +
      (result.rankedBy === "rerank" ? "" : `  RERANK UNAVAILABLE ${result.rerankFailure || ""}`),
  );
  result.top.forEach((item, index) => {
    if ( index === result.evidenceLimit ) {
      console.log(
        result.gate === "scope check"
          ? "  -- below here the model sees it only if the check's search query ranks it higher"
          : "  -- below here the model does not see it",
      );
    }
    console.log(
      `  ${item.expected ? "*" : " "}${index + 1}. ${formatScore(item.score)}  ${item.label}` +
        (item.preview ? `  "${item.preview}"` : ""),
    );
  });
};

const printSummary = (results, config) => {
  const answerable = results.filter((result) => !result.expectAbstain);
  const abstaining = results.filter((result) => result.expectAbstain);
  const outOfScope = abstaining.filter((result) => result.category === OUT_OF_SCOPE);
  // The scope check runs only on a reranked list. A case that fell back to the
  // fused order has no band, and its score is on another scale.
  const fusedOrder = results.filter((result) => result.rankedBy !== "rerank");
  const hasBand =
    fusedOrder.length === 0 &&
    Number.isFinite(config.scopeCheckBelow) &&
    config.scopeCheckBelow > config.minRerankScore;
  // Without a band the floor alone has to stop the out-of-scope questions too.
  const floorOnly = hasBand ? abstaining.filter((result) => result.category !== OUT_OF_SCOPE) : abstaining;
  const count = (items, key) => items.filter((item) => item[key]).length;
  const ids = (items) => items.map((item) => item.id).join(", ") || "none";
  const inBand = (items) => items.filter((item) => item.gate === "scope check");
  const byBest = (items) =>
    [...items]
      .filter((item) => Number.isFinite(item.bestScore))
      .sort((left, right) => left.bestScore - right.bestScore);
  const weakestAnswerable = byBest(answerable)[0];
  const strongestFloorOnly = byBest(floorOnly).at(-1);
  const strongestOutOfScope = [...outOfScope]
    .filter((item) => Number.isFinite(item.handbookScore))
    .sort((left, right) => left.handbookScore - right.handbookScore)
    .at(-1);

  console.log("");
  console.log(
    `RAG_MIN_RERANK_SCORE=${config.minRerankScore}  RAG_SCOPE_CHECK_BELOW=${hasBand ? config.scopeCheckBelow : "off"}` +
      `  RAG_CANDIDATES_PER_GROUP=${config.candidatesPerGroup}  RAG_EVIDENCE_LIMIT=${config.evidenceLimit}`,
  );
  if ( fusedOrder.length > 0 ) {
    console.log(`fused order, so no scope check and fused scores in the windows: ${ids(fusedOrder)}`);
  }
  console.log(
    `answerable: expected source reaches the model in ${count(answerable, "reachesModel")}/${answerable.length}` +
      ` (fused order without rerank: ${count(answerable, "reachesModelWithoutRerank")}/${answerable.length})`,
  );
  console.log(`  misses: ${ids(answerable.filter((item) => !item.reachesModel))}`);
  console.log(`  below the floor, so they abstain: ${ids(answerable.filter((item) => item.gate === "abstains"))}`);
  console.log(`  in the band, answered once the scope check says yes: ${ids(inBand(answerable))}`);
  console.log(
    `  expected source never retrieved: ${ids(answerable.filter((item) => item.expectedRank < 0))}`,
  );
  console.log(
    `must abstain: abstains in ${count(abstaining, "abstains")}/${abstaining.length}` +
      ` (fused order without rerank: ${count(abstaining, "reachesModelWithoutRerank")}/${abstaining.length});` +
      ` answers anyway: ${ids(abstaining.filter((item) => !item.abstains))}`,
  );
  console.log(`  in the band, abstaining only if the scope check says no: ${ids(inBand(outOfScope))}`);
  if ( weakestAnswerable && strongestFloorOnly ) {
    const low = strongestFloorOnly.bestScore;
    const high = weakestAnswerable.bestScore;
    console.log(
      `floor window on the best score: above ${formatScore(low)} (${strongestFloorOnly.id})` +
        ` and at or below ${formatScore(high)} (${weakestAnswerable.id})` +
        (low < high ? "" : "  -- NO SINGLE FLOOR SEPARATES THESE"),
    );
  }
  if ( hasBand && strongestOutOfScope ) {
    const clears = config.scopeCheckBelow > strongestOutOfScope.handbookScore;
    console.log(
      `scope-check bound on the handbook's best score: above ${formatScore(strongestOutOfScope.handbookScore)}` +
        ` (${strongestOutOfScope.id})` +
        (clears ? "" : `  -- ${config.scopeCheckBelow} DOES NOT CLEAR IT, SO IT IS ANSWERED`),
    );
  }
};

const positiveIntegerAfter = (argument, prefix) => {
  const value = Number.parseInt(argument.slice(prefix.length), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
};

export const parseReportArgs = (argv) => {
  const options = { ids: null, candidatesPerGroup: null, top: null };
  argv.forEach((argument) => {
    if ( argument.startsWith("--ids=") ) {
      options.ids = argument
        .slice("--ids=".length)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    }
    if ( argument.startsWith("--candidates-per-group=") ) {
      options.candidatesPerGroup = positiveIntegerAfter(argument, "--candidates-per-group=");
    }
    // List this many ranked chunks per case, with the start of each one's
    // text, to see what just missed the model.
    if ( argument.startsWith("--top=") ) {
      options.top = positiveIntegerAfter(argument, "--top=");
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
      const result = await reportCase({ evalCase, config, embeddings, rerankClient, listCount: options.top });
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
