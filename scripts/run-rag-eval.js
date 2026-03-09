import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, "..");
const evalSetPath = path.join(
  serverRoot,
  "LeaseQA",
  "RAG",
  "evals",
  "tenant-rights-eval.json",
);

const parseArgs = (argv) => {
  const options = {
    baseUrl: process.env.RAG_EVAL_BASE_URL || "http://127.0.0.1:4000",
    limit: null,
    ids: null,
  };

  argv.forEach((argument) => {
    if (argument.startsWith("--base-url=")) {
      options.baseUrl = argument.split("=")[1];
      return;
    }
    if (argument.startsWith("--limit=")) {
      options.limit = Number.parseInt(argument.split("=")[1], 10);
      return;
    }
    if (argument.startsWith("--ids=")) {
      options.ids = argument
        .split("=")[1]
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
  });

  return options;
};

const readEvalCases = async () => {
  const raw = await fs.readFile(evalSetPath, "utf8");
  return JSON.parse(raw);
};

const appendCookies = (cookieJar, response) => {
  const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
  const setCookies = getSetCookie ? getSetCookie() : [];

  setCookies.forEach((headerValue) => {
    const firstPart = headerValue.split(";")[0];
    const [name, ...rest] = firstPart.split("=");
    if (!name || rest.length === 0) {
      return;
    }
    cookieJar.set(name.trim(), rest.join("=").trim());
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

  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed (${response.status}): ${text}`);
  }

  return JSON.parse(text);
};

const createSession = async ({ baseUrl, cookieJar }) => {
  const formData = new FormData();
  formData.append(
    "sourceText",
    "Uploaded source intentionally blank for knowledge-base retrieval evaluation.",
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
  if (!citation) {
    return false;
  }

  if (citation.sourceGroup !== evalCase.expectedSourceGroup) {
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
    const lowerName = String(citation.sourceName || "").toLowerCase();
    return evalCase.expectedSourceNameIncludes.some((token) =>
      lowerName.includes(String(token).toLowerCase()),
    );
  }

  return true;
};

const isInsufficientSupportAnswer = (answer) =>
  /could not find enough support/i.test(String(answer || ""));

const runEvalCase = async ({ baseUrl, evalCase }) => {
  const cookieJar = new Map();
  const sessionId = await createSession({ baseUrl, cookieJar });
  const result = await askQuestion({
    baseUrl,
    cookieJar,
    sessionId,
    question: evalCase.question,
  });

  const firstCitation = result.citations?.[0] || null;
  const answerPresent = Boolean(result.answer?.trim());
  const abstained =
    answerPresent &&
    !firstCitation &&
    isInsufficientSupportAnswer(result.answer);
  const passed = answerPresent && matchesExpectation(evalCase, firstCitation);
  const status = passed ? "PASS" : abstained ? "ABSTAIN" : "FAIL";

  return {
    id: evalCase.id,
    category: evalCase.category,
    status,
    expectedSourceGroup: evalCase.expectedSourceGroup,
    expectedChapterRefs: evalCase.expectedChapterRefs || [],
    expectedSourceNameIncludes: evalCase.expectedSourceNameIncludes || [],
    actualSourceGroup: firstCitation?.sourceGroup || null,
    actualChapterRef: firstCitation?.chapterRef || null,
    actualSourceName: firstCitation?.sourceName || null,
    answerPreview: String(result.answer || "").slice(0, 160),
  };
};

const summarize = (results) => {
  const passedCount = results.filter((result) => result.status === "PASS").length;
  const abstainedCount = results.filter(
    (result) => result.status === "ABSTAIN",
  ).length;
  return {
    total: results.length,
    passed: passedCount,
    abstained: abstainedCount,
    failed: results.length - passedCount - abstainedCount,
    passRate: results.length === 0 ? 0 : passedCount / results.length,
    safeRate:
      results.length === 0 ? 0 : (passedCount + abstainedCount) / results.length,
  };
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  const allEvalCases = await readEvalCases();

  let selectedCases = allEvalCases;
  if (options.ids?.length) {
    const selectedIds = new Set(options.ids);
    selectedCases = allEvalCases.filter((evalCase) => selectedIds.has(evalCase.id));
  }
  if (Number.isInteger(options.limit) && options.limit > 0) {
    selectedCases = selectedCases.slice(0, options.limit);
  }

  const results = [];
  for (const evalCase of selectedCases) {
    const result = await runEvalCase({
      baseUrl: options.baseUrl,
      evalCase,
    });
    results.push(result);
    console.log(
      `${result.status} ${result.id} expected=${result.expectedSourceGroup} actual=${result.actualSourceGroup || "none"} chapter=${result.actualChapterRef || "n/a"} source=${result.actualSourceName || "n/a"}`,
    );
  }

  const summary = summarize(results);
  console.log(
    `SUMMARY total=${summary.total} passed=${summary.passed} abstained=${summary.abstained} failed=${summary.failed} passRate=${summary.passRate.toFixed(2)} safeRate=${summary.safeRate.toFixed(2)}`,
  );
};

const isExecutedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isExecutedDirectly) {
  main().catch((error) => {
    console.error("[RAG eval] Failed:", error);
    process.exit(1);
  });
}
