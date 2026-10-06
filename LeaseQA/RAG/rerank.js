import { runBoundedOperation } from "./operationPolicy.js";

// BigModel's documented per-request limits for POST /rerank.
const MAX_DOCUMENTS_PER_REQUEST = 128;
const MAX_TEXT_CHARS = 4096;

const joinUrl = (base, suffix) =>
  `${String(base || "").replace(/\/+$/, "")}/${String(suffix || "").replace(
    /^\/+/,
    "",
  )}`;

const truncate = (value) => String(value ?? "").slice(0, MAX_TEXT_CHARS);

const createRerankError = (message, { status, cause } = {}) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "RAG_RERANK_FAILED";
  if ( status !== undefined ) {
    error.status = status;
  }
  return error;
};

const scoreBatch = async ({ config, requestUrl, query, documents, fetchFn, retryPolicy }) =>
  runBoundedOperation({
    label: "rerank request",
    timeoutMs: config.rerankTimeoutMs,
    retryPolicy,
    operation: async (signal) => {
      const response = await fetchFn(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.rerankApiKey}`,
        },
        body: JSON.stringify({
          model: config.rerankModel,
          query: truncate(query),
          documents: documents.map(truncate),
          top_n: documents.length,
          return_documents: false,
          return_raw_scores: Boolean(config.rerankRawScores),
        }),
        signal,
      });

      let payload;
      try {
        payload = await response.json();
      } catch ( cause ) {
        throw createRerankError(
          response.ok
            ? "Rerank response was not valid JSON"
            : "Rerank request failed",
          { status: response.ok ? undefined : response.status, cause },
        );
      }
      if ( !response.ok ) {
        throw createRerankError(
          payload?.error?.message || "Rerank request failed",
          { status: response.status },
        );
      }

      const scores = new Array(documents.length).fill(null);
      for ( const result of payload?.results || [] ) {
        const index = result?.index;
        const score = result?.relevance_score;
        if (
          Number.isInteger(index) &&
          index >= 0 &&
          index < documents.length &&
          Number.isFinite(score)
        ) {
          scores[index] = score;
        }
      }
      if ( scores.some((score) => score === null) ) {
        throw createRerankError("Rerank response did not score every document");
      }
      return scores;
    },
  });

// Scores every document against the query independently, so batches of the
// provider's maximum size can be scored in parallel and concatenated.
export const createRerankClient = (
  config,
  { fetchFn = globalThis.fetch, retryPolicy } = {},
) => {
  if ( !config.rerankEnabled ) {
    return null;
  }
  const requestUrl = joinUrl(config.rerankBaseUrl, "rerank");

  return {
    rerank: async ({ query, documents }) => {
      const batches = [];
      for (
        let start = 0;
        start < documents.length;
        start += MAX_DOCUMENTS_PER_REQUEST
      ) {
        batches.push(documents.slice(start, start + MAX_DOCUMENTS_PER_REQUEST));
      }
      const scored = await Promise.all(
        batches.map((batch) =>
          scoreBatch({
            config,
            requestUrl,
            query,
            documents: batch,
            fetchFn,
            retryPolicy,
          }),
        ),
      );
      return scored.flat();
    },
  };
};
