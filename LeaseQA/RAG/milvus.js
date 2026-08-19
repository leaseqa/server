import { DataType, FunctionType, IndexType, MetricType, MilvusClient, RRFRanker, } from "@zilliz/milvus2-sdk-node";

const OUTPUT_FIELDS = [
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

const TEXT_FIELD = "text";
const DENSE_FIELD = "embedding";
const SPARSE_FIELD = "sparse_embedding";
const BM25_FUNCTION_NAME = "text_bm25";
const INSERT_BATCH_SIZE = 32;

let cachedClient = null;
const collectionDimensions = new Map();
const collectionSparseSupport = new Map();

const createClient = (config) => {
  if ( !cachedClient ) {
    cachedClient = new MilvusClient({
      address: config.milvusAddress,
      token: config.milvusToken || undefined,
    });
  }
  return cachedClient;
};

const runMilvusCall = (operation) => operation();

const getCollectionSupportsSparse = async ({ client, collectionName }) => {
  if ( collectionSparseSupport.has(collectionName) ) {
    return collectionSparseSupport.get(collectionName);
  }

  const description = await runMilvusCall(() =>
    client.describeCollection({
      collection_name: collectionName,
    }),
  );
  const hasSparseField = Boolean(description?.anns_fields?.[SPARSE_FIELD]);
  collectionSparseSupport.set(collectionName, hasSparseField);
  return hasSparseField;
};

const createCollectionIfMissing = async ({
                                           client,
                                           collectionName,
                                           dimension,
                                         }) => {
  if ( collectionDimensions.get(collectionName) === dimension ) {
    return;
  }

  const existing = await runMilvusCall(() =>
    client.hasCollection({
      collection_name: collectionName,
    }),
  );
  if ( !existing.value ) {
    await runMilvusCall(() =>
      client.createCollection({
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
      }),
    );

    await runMilvusCall(() =>
      client.createIndex({
        collection_name: collectionName,
        field_name: DENSE_FIELD,
        index_type: IndexType.AUTOINDEX,
        metric_type: MetricType.COSINE,
      }),
    );

    await runMilvusCall(() =>
      client.createIndex({
        collection_name: collectionName,
        field_name: SPARSE_FIELD,
        index_type: IndexType.SPARSE_INVERTED_INDEX,
        metric_type: MetricType.BM25,
      }),
    );
  }
  collectionDimensions.set(collectionName, dimension);
  collectionSparseSupport.set(collectionName, true);
};

const ensureCollectionLoaded = async ({ client, collectionName }) => {
  await runMilvusCall(() =>
    client.loadCollection({ collection_name: collectionName }),
  );
};

export const insertChunkRows = async ({
                                        config,
                                        collectionName,
                                        rows,
                                        dimension,
                                      }) => {
  if ( rows.length === 0 ) {
    return;
  }

  const client = createClient(config);
  await createCollectionIfMissing({ client, collectionName, dimension });

  for (
    let batchStart = 0;
    batchStart < rows.length;
    batchStart += INSERT_BATCH_SIZE
  ) {
    const batch = rows.slice(batchStart, batchStart + INSERT_BATCH_SIZE);
    await runMilvusCall(() =>
      client.insert({
        collection_name: collectionName,
        data: batch,
      }),
    );
  }
};

export const resetCollection = async ({ config, collectionName }) => {
  const client = createClient(config);
  const existing = await runMilvusCall(() =>
    client.hasCollection({
      collection_name: collectionName,
    }),
  );
  if ( !existing.value ) {
    return;
  }

  await runMilvusCall(() =>
    client.dropCollection({ collection_name: collectionName }),
  );
  collectionDimensions.delete(collectionName);
  collectionSparseSupport.delete(collectionName);
};

export const hasChunkCollection = async ({ config, collectionName }) => {
  const client = createClient(config);
  const existing = await runMilvusCall(() =>
    client.hasCollection({
      collection_name: collectionName,
    }),
  );
  return Boolean(existing.value);
};

export const deleteChunkRows = async ({ config, collectionName, filter }) => {
  if ( !filter ) {
    return;
  }

  const client = createClient(config);
  const existing = await runMilvusCall(() =>
    client.hasCollection({
      collection_name: collectionName,
    }),
  );
  if ( !existing.value ) {
    return;
  }

  await runMilvusCall(() =>
    client.delete({
      collection_name: collectionName,
      filter,
    }),
  );
};

export const searchChunks = async ({
                                     config,
                                     collectionName,
                                     vector,
                                     limit,
                                     filter,
                                   }) => {
  const client = createClient(config);
  const existing = await runMilvusCall(() =>
    client.hasCollection({
      collection_name: collectionName,
    }),
  );
  if ( !existing.value ) {
    return [];
  }

  await ensureCollectionLoaded({ client, collectionName });
  const response = await runMilvusCall(() =>
    client.search({
      collection_name: collectionName,
      data: [vector],
      anns_field: DENSE_FIELD,
      limit,
      metric_type: MetricType.COSINE,
      params: { nprobe: 10 },
      output_fields: OUTPUT_FIELDS,
      filter: filter || undefined,
    }),
  );

  return response.results || [];
};

export const searchHybridChunks = async ({
                                           config,
                                           collectionName,
                                           denseVector,
                                           sparseText,
                                           limit,
                                           filter,
                                         }) => {
  const client = createClient(config);
  const existing = await runMilvusCall(() =>
    client.hasCollection({
      collection_name: collectionName,
    }),
  );
  if ( !existing.value ) {
    return [];
  }

  const supportsSparse = await getCollectionSupportsSparse({
    client,
    collectionName,
  });

  if ( !supportsSparse ) {
    return searchChunks({
      config,
      collectionName,
      vector: denseVector,
      limit,
      filter,
    });
  }

  await ensureCollectionLoaded({ client, collectionName });
  const response = await runMilvusCall(() =>
    client.hybridSearch({
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
      output_fields: OUTPUT_FIELDS,
      rerank: RRFRanker(60),
    }),
  );

  return response.results || [];
};
