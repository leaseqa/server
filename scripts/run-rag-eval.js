import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  --eval-set=<path>   Evaluation case JSON file
  --output=<path>     JSON artifact path (default: artifacts/rag-eval.json)
  --limit=<count>     Run only the first count selected cases
  --ids=<id,...>      Run only comma-separated case IDs
  --help              Show this help without requiring credentials`;

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

const requestJson = async ({
  baseUrl,
  cookieJar,
  pathname,
  method = "GET",
  headers = {},
  body,
}) => {
  const cookieHeader = buildCookieHeader(cookieJar);
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...headers,
    },
    body,
  });
  appendCookies(cookieJar, response);
  const text = await response.text();
  if ( !response.ok ) {
    throw new Error(`${method} ${pathname} failed (${response.status})`);
  }
  return JSON.parse(text);
};

const createSession = async ({ baseUrl, cookieJar }) => {
  const formData = new FormData();
  formData.append(
    "sourceText",
    "Evaluation placeholder. Answers must use the knowledge corpus.",
  );
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

const matchesExpectation = (evalCase, citation) => {
  if ( !citation || citation.sourceGroup !== evalCase.expectedSourceGroup ) {
    return false;
  }
  if (
    Array.isArray(evalCase.expectedChapterRefs) &&
    evalCase.expectedChapterRefs.length > 0 &&
    !evalCase.expectedChapterRefs.includes(String(citation.chapterRef || ""))
  ) {
    return false;
  }
  if (
    Array.isArray(evalCase.expectedSourceNameIncludes) &&
    evalCase.expectedSourceNameIncludes.length > 0
  ) {
    const sourceName = String(citation.sourceName || "").toLowerCase();
    return evalCase.expectedSourceNameIncludes.some((token) =>
      sourceName.includes(String(token).toLowerCase()),
    );
  }
  return true;
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
  const sessionId = await createSession({ baseUrl, cookieJar });
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
    : citations.some((citation) => matchesExpectation(evalCase, citation));
  const passed = evalCase.expectAbstain
    ? abstained && citationValid && contentSafe
    : answerPresent && !abstained && expectedSourceMatched && citationValid && contentSafe;
  const safe = contentSafe && (evalCase.expectAbstain ? abstained : passed || abstained);

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
  };
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
  };
};

export const runEvaluation = async ({
  baseUrl,
  evalSetPath = defaultEvalSetPath,
  outputPath = defaultOutputPath,
  limit = null,
  ids = null,
  minPassRate = 0.9,
  minSafeRate = 0.98,
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
    const result = await runEvalCase({ baseUrl, evalCase });
    results.push(result);
    output.log(
      `${result.passed ? "PASS" : result.abstained ? "ABSTAIN" : "FAIL"} ${result.id} latencyMs=${result.latencyMs} sourceMatch=${result.expectedSourceMatched} citationValid=${result.citationValid}`,
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
  const minSafeRate = parsePositiveRate(env.RAG_EVAL_MIN_SAFE_RATE, 0.98);
  const artifact = await runEvaluation({
    ...options,
    minPassRate,
    minSafeRate,
    output,
  });
  const { summary } = artifact;
  output.log(
    `SUMMARY total=${summary.total} passed=${summary.passed} abstained=${summary.abstained} failed=${summary.failed} passRate=${summary.passRate.toFixed(2)} safeRate=${summary.safeRate.toFixed(2)} artifact=${options.outputPath}`,
  );
  if ( summary.passRate < minPassRate || summary.safeRate < minSafeRate ) {
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
      console.error("[RAG eval] Failed:", error?.message || "unknown error");
      process.exitCode = 1;
    });
}
