import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  matchesAnswerCitation,
  missingRequiredPoints,
  normalizeCitationExpectationInput,
  pastedSourceTextOf,
} from "../LeaseQA/RAG/evalExpectations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "..");
const defaultEvalSetPath = path.join(
  serverRoot,
  "LeaseQA",
  "RAG",
  "evals",
  "tenant-rights-eval.json",
);
const defaultOutputPath = path.join(serverRoot, "artifacts", "rag-eval.json");

const HELP = `Usage: node scripts/run-rag-eval.js [options]

Options:
  --base-url=<url>    LeaseQA server URL (default: http://127.0.0.1:4050)
  --eval-set=<path>   Evaluation case JSON file; cases with an "upload"
                      object (content/sourceName/mimeType) attach that
                      document to the session, and cases with a "sourceText"
                      string paste it the way a renter pastes a clause;
                      every other case gets placeholder text
  --output=<path>     JSON artifact path (default: artifacts/rag-eval.json)
  --limit=<count>     Run only the first count selected cases
  --ids=<id,...>      Run only comma-separated case IDs
  --help              Show this help without requiring credentials`;

export const EVAL_PLACEHOLDER_SOURCE_TEXT =
  "Evaluation placeholder. Answers must use the knowledge corpus.";

// The pasted text a case without an upload creates its session from: its own
// sourceText, or the placeholder. report-rag-retrieval.js ranks the same text,
// so its report describes what the eval's answers are built on.
export const evalSessionSourceText = (evalCase) =>
  pastedSourceTextOf(evalCase) ?? EVAL_PLACEHOLDER_SOURCE_TEXT;

const parsePositiveRate = (value, fallback) => {
  const parsed = Number.parseFloat(value || "");
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : fallback;
};

export const parseArgs = (argv, env = process.env) => {
  const options = {
    baseUrl: env.RAG_EVAL_BASE_URL || "http://127.0.0.1:4050",
    evalSetPath: env.RAG_EVAL_SET_PATH || defaultEvalSetPath,
    outputPath: env.RAG_EVAL_OUTPUT || defaultOutputPath,
    limit: null,
    ids: null,
    help: false,
  };

  argv.forEach((argument) => {
    if ( argument === "--help" || argument === "-h" ) {
      options.help = true;
      return;
    }
    if ( argument.startsWith("--base-url=") ) {
      options.baseUrl = argument.slice("--base-url=".length);
      return;
    }
    if ( argument.startsWith("--eval-set=") ) {
      options.evalSetPath = path.resolve(argument.slice("--eval-set=".length));
      return;
    }
    if ( argument.startsWith("--output=") ) {
      options.outputPath = path.resolve(argument.slice("--output=".length));
      return;
    }
    if ( argument.startsWith("--limit=") ) {
      options.limit = Number.parseInt(argument.slice("--limit=".length), 10);
      return;
    }
    if ( argument.startsWith("--ids=") ) {
      options.ids = argument
        .slice("--ids=".length)
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  });

  return options;
};

const readEvalCases = async (evalSetPath) => {
  const raw = await fs.readFile(evalSetPath, "utf8");
  return JSON.parse(raw);
};

const appendCookies = (cookieJar, response) => {
  const setCookies = response.headers.getSetCookie?.() ||
    [response.headers.get("set-cookie")].filter(Boolean);
  setCookies.forEach((headerValue) => {
    const firstPart = headerValue.split(";")[0];
    const [name, ...rest] = firstPart.split("=");
    if ( name && rest.length > 0 ) {
      cookieJar.set(name.trim(), rest.join("=").trim());
    }
  });
};

const buildCookieHeader = (cookieJar) =>
  [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

const createEvalError = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

const getSafeEvalErrorCode = (error) => {
  const code = String(error?.code || "");
  return /^RAG_EVAL_[A-Z0-9_]+$/.test(code)
    ? code
    : "RAG_EVAL_RUNTIME_ERROR";
};

const requestJson = async ({
  baseUrl,
  cookieJar,
  pathname,
  method = "GET",
  headers = {},
  body,
}) => {
  const cookieHeader = buildCookieHeader(cookieJar);
  let response;
  try {
    response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...headers,
      },
      body,
    });
  } catch {
    throw createEvalError("RAG_EVAL_NETWORK_ERROR");
  }
  appendCookies(cookieJar, response);
  const text = await response.text();
  if ( !response.ok ) {
    throw createEvalError(`RAG_EVAL_HTTP_${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw createEvalError("RAG_EVAL_RESPONSE_INVALID");
  }
};

const createSession = async ({ baseUrl, cookieJar, evalCase }) => {
  const formData = new FormData();
  const upload = evalCase?.upload;
  if ( upload && upload.content != null ) {
    formData.append(
      "file",
      new Blob([String(upload.content)], {
        type: upload.mimeType || "text/plain",
      }),
      upload.sourceName || "uploaded-document.txt",
    );
  } else {
    formData.append("sourceText", evalSessionSourceText(evalCase));
  }
  const response = await requestJson({
    baseUrl,
    cookieJar,
    pathname: "/api/rag/sessions",
    method: "POST",
    body: formData,
  });
  return response.data?._id;
};

const askQuestion = async ({ baseUrl, cookieJar, sessionId, question }) => {
  const response = await requestJson({
    baseUrl,
    cookieJar,
    pathname: `/api/rag/sessions/${sessionId}/messages`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: question }),
  });
  return response.data;
};

const isInsufficientSupportAnswer = (answer) =>
  /could not find enough support/i.test(String(answer || ""));

const isValidCitation = (citation) =>
  [
    citation?.citationId,
    citation?.sourceName,
    citation?.sourceGroup,
    citation?.sourceType,
    citation?.snippet,
  ].every((value) => typeof value === "string" && value.trim().length > 0);

export const runEvalCase = async ({ baseUrl, evalCase, clock = performance }) => {
  const startedAt = clock.now();
  const cookieJar = new Map();
  const sessionId = await createSession({ baseUrl, cookieJar, evalCase });
  const result = await askQuestion({
    baseUrl,
    cookieJar,
    sessionId,
    question: evalCase.question,
  });
  const citations = Array.isArray(result.citations) ? result.citations : [];
  const answerPresent = Boolean(result.answer?.trim());
  const abstained =
    answerPresent && citations.length === 0 && isInsufficientSupportAnswer(result.answer);
  const citationValid =
    citations.length === 0 ? abstained : citations.every(isValidCitation);
  const normalizedAnswer = String(result.answer || "").toLowerCase();
  const contentSafe = (evalCase.forbiddenAnswerIncludes || []).every(
    (token) => !normalizedAnswer.includes(String(token).toLowerCase()),
  );
  const expectedSourceMatched = evalCase.expectAbstain
    ? abstained
    : citations.some((citation) =>
        matchesAnswerCitation(evalCase, normalizeCitationExpectationInput(citation)),
      );
  // The points the answer should state but does not. Only an answer is read:
  // an abstention or an empty reply fails already, and counting its points too
  // would blur which answers came back incomplete.
  const answered = answerPresent && !abstained;
  const missingPoints =
    !evalCase.expectAbstain && answered ? missingRequiredPoints(evalCase, result.answer) : [];
  const passed = evalCase.expectAbstain
    ? abstained && citationValid && contentSafe
    : answerPresent &&
      !abstained &&
      expectedSourceMatched &&
      citationValid &&
      contentSafe &&
      missingPoints.length === 0;
  // Safe means the answer cannot mislead a renter: no forbidden content, an
  // out-of-scope question abstains, and an answer either cites well-formed
  // evidence or abstains outright. What an answer cites and says is left to
  // passed: the model may cite another legally adequate passage than the one
  // the case names, and an answer that leaves out a required point is
  // incomplete rather than misleading, so either lowers the pass rate, not the
  // safe rate.
  const safe =
    contentSafe && citationValid && (!evalCase.expectAbstain || abstained);

  return {
    id: evalCase.id,
    category: evalCase.category,
    latencyMs: Math.max(0, Math.round(clock.now() - startedAt)),
    answerPresent,
    expectedSourceMatched,
    citationValid,
    contentSafe,
    abstained,
    passed,
    safe,
    actualCitationIds: citations
      .map((citation) => citation.citationId)
      .filter(Boolean),
    actualSourceGroups: [
      ...new Set(citations.map((citation) => citation.sourceGroup).filter(Boolean)),
    ],
    missingPoints,
    // Kept so a missed point can be read against what the model said. An
    // answer with forbidden content may carry a leaked prompt or key, so it is
    // never copied into the artifact.
    answer: contentSafe ? String(result.answer ?? "") : null,
  };
};

const pointsNote = (evalCase, result) => {
  if ( !evalCase.requiredPoints?.length ) {
    return "";
  }
  if ( !result.answerPresent || result.abstained ) {
    return " points=n/a";
  }
  return result.missingPoints?.length
    ? ` points=missing(${result.missingPoints.join("|")})`
    : " points=ok";
};

export const summarize = (results) => {
  const passed = results.filter((result) => result.passed).length;
  const abstained = results.filter((result) => result.abstained).length;
  const safe = results.filter((result) => result.safe).length;
  return {
    total: results.length,
    passed,
    abstained,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    safeRate: results.length === 0 ? 0 : safe / results.length,
    runtimeFailures: results.filter((result) => result.errorCode).length,
    pointsMissed: results.filter((result) => result.missingPoints?.length > 0).length,
  };
};

export const runEvaluation = async ({
  baseUrl,
  evalSetPath = defaultEvalSetPath,
  outputPath = defaultOutputPath,
  limit = null,
  ids = null,
  minPassRate = 0.9,
  minSafeRate = 1,
  output = console,
}) => {
  let selectedCases = await readEvalCases(evalSetPath);
  if ( ids?.length ) {
    const selectedIds = new Set(ids);
    selectedCases = selectedCases.filter((evalCase) =>
      selectedIds.has(evalCase.id),
    );
  }
  if ( Number.isInteger(limit) && limit > 0 ) {
    selectedCases = selectedCases.slice(0, limit);
  }

  const results = [];
  for ( const evalCase of selectedCases ) {
    const startedAt = performance.now();
    let result;
    try {
      result = await runEvalCase({ baseUrl, evalCase });
    } catch ( error ) {
      result = {
        id: evalCase.id,
        category: evalCase.category,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        answerPresent: false,
        expectedSourceMatched: false,
        citationValid: false,
        contentSafe: false,
        abstained: false,
        passed: false,
        safe: false,
        actualCitationIds: [],
        actualSourceGroups: [],
        missingPoints: [],
        answer: null,
        errorCode: getSafeEvalErrorCode(error),
      };
    }
    results.push(result);
    output.log(
      `${result.passed ? "PASS" : result.abstained ? "ABSTAIN" : "FAIL"} ${result.id} latencyMs=${result.latencyMs} sourceMatch=${result.expectedSourceMatched} citationValid=${result.citationValid} safe=${result.safe}${pointsNote(evalCase, result)}`,
    );
  }

  const artifact = {
    generatedAt: new Date().toISOString(),
    thresholds: { minPassRate, minSafeRate },
    summary: summarize(results),
    results,
  };
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
};

export const main = async (
  argv = process.argv.slice(2),
  env = process.env,
  output = console,
) => {
  const options = parseArgs(argv, env);
  if ( options.help ) {
    output.log(HELP);
    return 0;
  }
  const minPassRate = parsePositiveRate(env.RAG_EVAL_MIN_PASS_RATE, 0.9);
  const minSafeRate = parsePositiveRate(env.RAG_EVAL_MIN_SAFE_RATE, 1);
  const artifact = await runEvaluation({
    ...options,
    minPassRate,
    minSafeRate,
    output,
  });
  const { summary } = artifact;
  output.log(
    `SUMMARY total=${summary.total} passed=${summary.passed} abstained=${summary.abstained} failed=${summary.failed} pointsMissed=${summary.pointsMissed} passRate=${summary.passRate.toFixed(2)} safeRate=${summary.safeRate.toFixed(2)} artifact=${options.outputPath}`,
  );
  if (
    summary.runtimeFailures > 0 ||
    summary.passRate < minPassRate ||
    summary.safeRate < minSafeRate
  ) {
    output.error(
      `RAG evaluation thresholds failed: pass>=${minPassRate.toFixed(2)} safe>=${minSafeRate.toFixed(2)}`,
    );
    return 1;
  }
  return 0;
};

const isExecutedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if ( isExecutedDirectly ) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          event: "rag_eval_failed",
          errorCode: getSafeEvalErrorCode(error),
        }),
      );
      process.exitCode = 1;
    });
}
