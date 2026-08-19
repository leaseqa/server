const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_TOTAL_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 2000;
const DEFAULT_JITTER_RATIO = 0.2;

const NETWORK_ERROR_CODES = new Set([
  "14",
  "4",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "RAG_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const getHttpStatus = (error) => {
  const status =
    error?.status ??
    error?.statusCode ??
    error?.response?.status ??
    error?.cause?.status;
  const parsed = Number(status);
  return Number.isInteger(parsed) ? parsed : null;
};

const getNetworkErrorCode = (error) =>
  String(error?.code || error?.cause?.code || error?.error?.code || "");

const isTransientError = (error) => {
  const status = getHttpStatus(error);
  if ( status !== null ) {
    return status === 429 || status >= 500;
  }

  return (
    NETWORK_ERROR_CODES.has(getNetworkErrorCode(error)) ||
    /\b(?:UNAVAILABLE|DEADLINE_EXCEEDED|deadline exceeded|Connection dropped|RST_STREAM|timed out|network|socket)\b/i.test(
      error?.message || "",
    ) ||
    (error instanceof TypeError && /fetch|network|socket/i.test(error.message))
  );
};

export const withTimeout = async (operation, timeoutMs, label) => {
  if ( typeof operation !== "function" ) {
    throw new TypeError("operation must be a function");
  }
  if ( !Number.isFinite(timeoutMs) || timeoutMs <= 0 ) {
    throw new TypeError("timeoutMs must be a positive number");
  }

  const controller = new AbortController();
  let timer;
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label || "RAG operation"} timed out after ${timeoutMs}ms`);
      error.code = "RAG_TIMEOUT";
      error.timeoutMs = timeoutMs;
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeoutPromise,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export const retryTransient = async (operation, policy = {}) => {
  if ( typeof operation !== "function" ) {
    throw new TypeError("operation must be a function");
  }

  const requestedAttempts = Number.isInteger(policy.maxAttempts)
    ? policy.maxAttempts
    : DEFAULT_MAX_ATTEMPTS;
  const maxAttempts = Math.max(
    1,
    Math.min(MAX_TOTAL_ATTEMPTS, requestedAttempts),
  );
  const baseDelayMs = Number.isFinite(policy.baseDelayMs)
    ? Math.max(0, policy.baseDelayMs)
    : DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = Number.isFinite(policy.maxDelayMs)
    ? Math.max(0, Math.min(2000, policy.maxDelayMs))
    : DEFAULT_MAX_DELAY_MS;
  const jitterRatio = Number.isFinite(policy.jitterRatio)
    ? Math.min(1, Math.max(0, policy.jitterRatio))
    : DEFAULT_JITTER_RATIO;
  const sleep = policy.sleep || defaultSleep;
  const random = policy.random || Math.random;

  for ( let attempt = 1; attempt <= maxAttempts; attempt += 1 ) {
    try {
      return await operation(attempt);
    } catch ( error ) {
      if ( attempt === maxAttempts || !isTransientError(error) ) {
        throw error;
      }

      const exponentialDelay = Math.min(
        maxDelayMs,
        baseDelayMs * 2 ** (attempt - 1),
      );
      const jitterMultiplier =
        1 - jitterRatio + Math.min(1, Math.max(0, random())) * jitterRatio * 2;
      const delay = Math.min(
        maxDelayMs,
        Math.round(exponentialDelay * jitterMultiplier),
      );
      await sleep(delay);
    }
  }

  throw new Error("RAG retry policy exhausted unexpectedly");
};

export const runBoundedOperation = ({
                                      operation,
                                      timeoutMs,
                                      label,
                                      retryPolicy,
                                    }) =>
  retryTransient(
    () => withTimeout(operation, timeoutMs, label),
    retryPolicy,
  );
