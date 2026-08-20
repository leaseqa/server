import {
  DataType,
  ErrorCode,
  FunctionType,
  IndexType,
  LoadState,
  MetricType,
  MilvusClient,
  RRFRanker,
} from "@zilliz/milvus2-sdk-node";
import { retryTransient } from "./operationPolicy.js";

export const SESSION_OUTPUT_FIELDS = [
  "text",
  "source_name",
  "source_group",
  "source_type",
  "chapter_ref",
  "file_path",
  "source_url",
  "session_id",
  "title_hint",
  "priority",
];

export const KNOWLEDGE_OUTPUT_FIELDS = [
  ...SESSION_OUTPUT_FIELDS,
  "source_hash",
  "page",
  "section",
  "corpus_version",
];

const TEXT_FIELD = "text";
const DENSE_FIELD = "embedding";
const SPARSE_FIELD = "sparse_embedding";
const BM25_FUNCTION_NAME = "text_bm25";
const INSERT_BATCH_SIZE = 32;
const LOAD_POLL_INTERVAL_MS = 400;

let cachedClient = null;
const collectionDimensions = new Map();
const collectionSparseSupport = new Map();

export const createMilvusClient = (
  config,
  { MilvusClientClass = MilvusClient } = {},
) =>
  new MilvusClientClass({
    address: config.milvusAddress,
    token: config.milvusToken || undefined,
    maxRetries: 0,
    timeout: config.vectorTimeoutMs,
    isGlobal: false,
  });

const createClient = (config) => {
  if ( !cachedClient ) {
    cachedClient = createMilvusClient(config);
  }
  return cachedClient;
};

const withRpcDeadline = (config, request) => ({
  ...request,
  timeout: config.vectorTimeoutMs,
});

const getOutputFields = (config, collectionName) =>
  collectionName === config.knowledgeCollection ||
  collectionName.startsWith(`${config.knowledgeCollection}_`)
    ? KNOWLEDGE_OUTPUT_FIELDS
    : SESSION_OUTPUT_FIELDS;

const createMilvusStatusError = (status) => {
  const providerStatus = String(status?.error_code || "UnknownError");
  const reason = String(status?.reason || "unknown");
  const error = new Error(`Milvus ${providerStatus}: ${reason}`);
  error.code = "RAG_MILVUS_STATUS_ERROR";
  error.status = providerStatus;
  error.providerReason = reason;
  error.retryable = /(?:RateLimit|Unavailable|Timeout|DeadlineExceeded)/i.test(
    providerStatus,
  );
  return error;
};

const assertSuccessfulStatus = (response) => {
  const status = response?.status || response;
  if ( status?.error_code && status.error_code !== ErrorCode.SUCCESS ) {
    throw createMilvusStatusError(status);
  }
  return response;
};

export const runMilvusRead = ({
                                config,
                                client,
                                method,
                                request,
                                retryPolicy,
                              }) =>
  retryTransient(
    async () =>
      assertSuccessfulStatus(
        await client[method](withRpcDeadline(config, request)),
      ),
    retryPolicy,
  );

export const runMilvusMutation = async ({ config, client, method, request }) =>
  assertSuccessfulStatus(
    await client[method](withRpcDeadline(config, request)),
  );

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const createVectorTimeoutError = (timeoutMs) => {
  const error = new Error(`Milvus load timed out after ${timeoutMs}ms`);
  error.code = "RAG_TIMEOUT";
  error.timeoutMs = timeoutMs;
  return error;
};

export const ensureCollectionLoaded = async ({
                                               config,
                                               client: providedClient,
                                               collectionName,
                                               createClient: createClientFn = createClient,
                                               clock = { now: Date.now },
                                               sleep = defaultSleep,
                                               pollIntervalMs = LOAD_POLL_INTERVAL_MS,
                                             }) => {
  const client = providedClient || createClientFn(config);
  const timeoutMs = config.vectorTimeoutMs;
  const deadline = clock.now() + timeoutMs;
  const remainingTime = () => {
    const remaining = deadline - clock.now();
    if ( remaining <= 0 ) {
      throw createVectorTimeoutError(timeoutMs);
    }
    return remaining;
  };
  const callBeforeDeadline = async (method, request) => {
    const remaining = remainingTime();
    try {
      const response = await client[method]({
        ...request,
        timeout: remaining,
      });
      remainingTime();
      return response;
    } catch ( error ) {
      if (
        clock.now() >= deadline ||
        String(error?.code || "") === "4" ||
        /\b(?:DEADLINE_EXCEEDED|deadline exceeded)\b/i.test(error?.message || "")
      ) {
        throw createVectorTimeoutError(timeoutMs);
      }
      throw error;
    }
  };

  const loadStatus = await callBeforeDeadline("loadCollectionAsync", {
    collection_name: collectionName,
  });
  assertSuccessfulStatus(loadStatus);

  while ( true ) {
    const state = await callBeforeDeadline("getLoadState", {
      collection_name: collectionName,
    });
    assertSuccessfulStatus(state);
    if ( state.state === LoadState.LoadStateLoaded ) {
      return loadStatus;
    }

    const remaining = remainingTime();
    await sleep(Math.min(pollIntervalMs, remaining));
  }
};

const getCollectionSupportsSparse = async ({
                                             config,
                                             client,
                                             collectionName,
                                             retryPolicy,
                                           }) => {
  if ( collectionSparseSupport.has(collectionName) ) {
    return collectionSparseSupport.get(collectionName);
  }

  const description = await runMilvusRead({
    config,
    client,
    method: "describeCollection",
    request: { collection_name: collectionName },
    retryPolicy,
  });
  const hasSparseField = Boolean(description?.anns_fields?.[SPARSE_FIELD]);
  collectionSparseSupport.set(collectionName, hasSparseField);
  return hasSparseField;
};

const createCollectionIfMissing = async ({
                                           config,
                                           client,
                                           collectionName,
                                           dimension,
                                           retryPolicy,
                                         }) => {
  if ( collectionDimensions.get(collectionName) === dimension ) {
    return;
  }

  const existing = await runMilvusRead({
    config,
    client,
    method: "hasCollection",
    request: { collection_name: collectionName },
    retryPolicy,
  });
  if ( !existing.value ) {
    await runMilvusMutation({
      config,
      client,
      method: "createCollection",
      request: {
        collection_name: collectionName,
        enable_dynamic_field: false,
        fields: [
          {
            name: "id",
            data_type: DataType.VarChar,
            is_primary_key: true,
            max_length: 128,
          },
          {
            name: "text",
            data_type: DataType.VarChar,
            max_length: 16384,
            enable_analyzer: true,
            enable_match: true,
          },
          {
            name: "source_name",
            data_type: DataType.VarChar,
            max_length: 256,
          },
          {
            name: "source_group",
            data_type: DataType.VarChar,
            max_length: 64,
          },
          {
            name: "source_type",
            data_type: DataType.VarChar,
            max_length: 64,
          },
          {
            name: "chapter_ref",
            data_type: DataType.VarChar,
            max_length: 64,
          },
          {
            name: "file_path",
            data_type: DataType.VarChar,
            max_length: 1024,
          },
          {
            name: "source_url",
            data_type: DataType.VarChar,
            max_length: 2048,
          },
          {
            name: "session_id",
            data_type: DataType.VarChar,
            max_length: 128,
          },
          {
            name: "title_hint",
            data_type: DataType.VarChar,
            max_length: 512,
          },
          {
            name: "priority",
            data_type: DataType.VarChar,
            max_length: 16,
          },
          {
            name: "source_hash",
            data_type: DataType.VarChar,
            max_length: 64,
            default_value: "",
          },
          {
            name: "page",
            data_type: DataType.VarChar,
            max_length: 32,
            default_value: "",
          },
          {
            name: "section",
            data_type: DataType.VarChar,
            max_length: 512,
            default_value: "",
          },
          {
            name: "corpus_version",
            data_type: DataType.VarChar,
            max_length: 64,
            default_value: "",
          },
          {
            name: DENSE_FIELD,
            data_type: DataType.FloatVector,
            dim: dimension,
          },
          {
            name: SPARSE_FIELD,
            data_type: DataType.SparseFloatVector,
            is_function_output: true,
          },
        ],
        functions: [
          {
            name: BM25_FUNCTION_NAME,
            description: "Built-in BM25 sparse encoder for chunk text",
            type: FunctionType.BM25,
            input_field_names: [TEXT_FIELD],
            output_field_names: [SPARSE_FIELD],
            params: {},
          },
        ],
      },
    });

    await runMilvusMutation({
      config,
      client,
      method: "createIndex",
      request: {
        collection_name: collectionName,
        field_name: DENSE_FIELD,
        index_type: IndexType.AUTOINDEX,
        metric_type: MetricType.COSINE,
      },
    });

    await runMilvusMutation({
      config,
      client,
      method: "createIndex",
      request: {
        collection_name: collectionName,
        field_name: SPARSE_FIELD,
        index_type: IndexType.SPARSE_INVERTED_INDEX,
        metric_type: MetricType.BM25,
      },
    });
  }
  collectionDimensions.set(collectionName, dimension);
  collectionSparseSupport.set(collectionName, true);
};

export const insertChunkRows = async ({
                                        config,
                                        collectionName,
                                        rows,
                                        dimension,
                                        client: providedClient,
                                        retryPolicy,
                                      }) => {
  if ( rows.length === 0 ) {
    return;
  }

  const client = providedClient || createClient(config);
  await createCollectionIfMissing({
    config,
    client,
    collectionName,
    dimension,
    retryPolicy,
  });

  for (
    let batchStart = 0;
    batchStart < rows.length;
    batchStart += INSERT_BATCH_SIZE
  ) {
    const batch = rows.slice(batchStart, batchStart + INSERT_BATCH_SIZE);
    await runMilvusMutation({
      config,
      client,
      method: "insert",
      request: {
        collection_name: collectionName,
        data: batch,
      },
    });
  }
};

export const resetCollection = async ({
                                        config,
                                        collectionName,
                                        client: providedClient,
                                        retryPolicy,
                                      }) => {
  const client = providedClient || createClient(config);
  const existing = await runMilvusRead({
    config,
    client,
    method: "hasCollection",
    request: { collection_name: collectionName },
    retryPolicy,
  });
  if ( !existing.value ) {
    return;
  }

  await runMilvusMutation({
    config,
    client,
    method: "dropCollection",
    request: { collection_name: collectionName },
  });
  collectionDimensions.delete(collectionName);
  collectionSparseSupport.delete(collectionName);
};

export const flushCollection = async ({
                                        config,
                                        collectionName,
                                        client: providedClient,
                                      }) => {
  const client = providedClient || createClient(config);
  return runMilvusMutation({
    config,
    client,
    method: "flushSync",
    request: { collection_names: [collectionName] },
  });
};

const isMissingAlias = (value) =>
  /alias.*(?:not found|not exist|can't find)|(?:not found|not exist).*alias/i.test(
    String(value || ""),
  );

export const getAliasTarget = async ({
                                      config,
                                      alias,
                                      client: providedClient,
                                      retryPolicy,
                                    }) => {
  const client = providedClient || createClient(config);
  try {
    const response = await runMilvusRead({
      config,
      client,
      method: "describeAlias",
      request: { alias, collection_name: alias },
      retryPolicy,
    });
    const status = response?.status || response;
    if ( status?.error_code && status.error_code !== ErrorCode.SUCCESS ) {
      if ( isMissingAlias(status.reason) ) {
        return null;
      }
      assertSuccessfulStatus(response);
    }
    return response.collection || response.collection_name || null;
  } catch ( error ) {
    if ( isMissingAlias(error?.message) ) {
      return null;
    }
    throw error;
  }
};

export const activateCollectionAlias = async ({
                                               config,
                                               alias,
                                               collectionName,
                                               client: providedClient,
                                               retryPolicy,
                                             }) => {
  const client = providedClient || createClient(config);
  const currentTarget = await getAliasTarget({
    config,
    alias,
    client,
    retryPolicy,
  });
  if ( currentTarget === collectionName ) {
    return currentTarget;
  }
  await runMilvusMutation({
    config,
    client,
    method: currentTarget ? "alterAlias" : "createAlias",
    request: {
      alias,
      collection_name: collectionName,
    },
  });
  return currentTarget;
};

export const listCollections = async ({
                                       config,
                                       client: providedClient,
                                       retryPolicy,
                                     }) => {
  const client = providedClient || createClient(config);
  const response = await runMilvusRead({
    config,
    client,
    method: "showCollections",
    request: {},
    retryPolicy,
  });
  assertSuccessfulStatus(response);
  if ( Array.isArray(response.collection_names) ) {
    return response.collection_names;
  }
  return (response.data || [])
    .map((collection) => collection.name || collection.collection_name)
    .filter(Boolean);
};

export const hasChunkCollection = async ({
                                          config,
                                          collectionName,
                                          client: providedClient,
                                          retryPolicy,
                                        }) => {
  const client = providedClient || createClient(config);
  const existing = await runMilvusRead({
    config,
    client,
    method: "hasCollection",
    request: { collection_name: collectionName },
    retryPolicy,
  });
  return Boolean(existing.value);
};

export const deleteChunkRows = async ({
                                        config,
                                        collectionName,
                                        filter,
                                        client: providedClient,
                                        retryPolicy,
                                      }) => {
  if ( !filter ) {
    return;
  }

  const client = providedClient || createClient(config);
  const existing = await runMilvusRead({
    config,
    client,
    method: "hasCollection",
    request: { collection_name: collectionName },
    retryPolicy,
  });
  if ( !existing.value ) {
    return;
  }

  await runMilvusMutation({
    config,
    client,
    method: "delete",
    request: {
      collection_name: collectionName,
      filter,
    },
  });
};

const escapeMilvusString = (value) =>
  String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');

export const deleteSessionChunks = ({
                                      config,
                                      collectionName = config.sessionCollection,
                                      sessionId,
                                      client,
                                      retryPolicy,
                                    }) =>
  deleteChunkRows({
    config,
    collectionName,
    filter: `session_id == "${escapeMilvusString(sessionId)}"`,
    client,
    retryPolicy,
  });

export const searchChunks = async ({
                                     config,
                                     collectionName,
                                     vector,
                                     limit,
                                     filter,
                                     client: providedClient,
                                     retryPolicy,
                                   }) => {
  const client = providedClient || createClient(config);
  const existing = await runMilvusRead({
    config,
    client,
    method: "hasCollection",
    request: { collection_name: collectionName },
    retryPolicy,
  });
  if ( !existing.value ) {
    return [];
  }

  await ensureCollectionLoaded({ config, client, collectionName });
  const response = await runMilvusRead({
    config,
    client,
    method: "search",
    request: {
      collection_name: collectionName,
      data: [vector],
      anns_field: DENSE_FIELD,
      limit,
      metric_type: MetricType.COSINE,
      params: { nprobe: 10 },
      output_fields: getOutputFields(config, collectionName),
      filter: filter || undefined,
    },
    retryPolicy,
  });

  return response.results || [];
};

export const searchHybridChunks = async ({
                                           config,
                                           collectionName,
                                           denseVector,
                                           sparseText,
                                           limit,
                                           filter,
                                           client: providedClient,
                                           retryPolicy,
                                         }) => {
  const client = providedClient || createClient(config);
  const existing = await runMilvusRead({
    config,
    client,
    method: "hasCollection",
    request: { collection_name: collectionName },
    retryPolicy,
  });
  if ( !existing.value ) {
    return [];
  }

  const supportsSparse = await getCollectionSupportsSparse({
    config,
    client,
    collectionName,
    retryPolicy,
  });

  if ( !supportsSparse ) {
    return searchChunks({
      config,
      collectionName,
      vector: denseVector,
      limit,
      filter,
      client,
      retryPolicy,
    });
  }

  await ensureCollectionLoaded({ config, client, collectionName });
  const response = await runMilvusRead({
    config,
    client,
    method: "hybridSearch",
    request: {
      collection_name: collectionName,
      data: [
        {
          anns_field: DENSE_FIELD,
          data: [denseVector],
          metric_type: MetricType.COSINE,
          params: { nprobe: 10 },
        },
        {
          anns_field: SPARSE_FIELD,
          data: sparseText,
          metric_type: MetricType.BM25,
          params: { drop_ratio_search: 0 },
        },
      ],
      filter: filter || undefined,
      limit,
      output_fields: getOutputFields(config, collectionName),
      rerank: RRFRanker(60),
    },
    retryPolicy,
  });

  return response.results || [];
};
