import test from "node:test";
import assert from "node:assert/strict";
import { getRagConfig } from "./config.js";
import * as ragConfig from "./config.js";
import {
  DASHSCOPE_COMPATIBLE_BASE_URL,
  DASHSCOPE_DEFAULT_CHAT_MODEL,
  DASHSCOPE_DEFAULT_EMBEDDING_DIMENSION,
  DASHSCOPE_DEFAULT_EMBEDDING_MODEL,
} from "../shared/ragProviders.js";

const withEnv = (overrides, callback) => {
  const original = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]]),
  );

  Object.entries(overrides).forEach(([key, value]) => {
    if ( value === undefined ) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });

  try {
    callback();
  } finally {
    Object.entries(original).forEach(([key, value]) => {
      if ( value === undefined ) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  }
};

test("getRagConfig defaults chat and embedding to DashScope OpenAI-compatible APIs", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      DASHSCOPE_API_KEY: "dashscope-key",
      RAG_CHAT_API_KEY: undefined,
      RAG_CHAT_MODEL: undefined,
      RAG_CHAT_BASE_URL: undefined,
      RAG_EMBEDDING_API_KEY: undefined,
      RAG_EMBEDDING_MODEL: undefined,
      RAG_EMBEDDING_BASE_URL: undefined,
      RAG_EMBEDDING_DIMENSION: undefined,
      RAG_EMBEDDING_DIMENSIONS: undefined,
      RAG_EMBEDDING_PROVIDER: undefined,
      RAG_PROVIDER: undefined,
      ARK_API_KEY: undefined,
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.chatApiKey, "dashscope-key");
      assert.equal(config.ragProvider, "dashscope");
      assert.equal(config.chatModel, DASHSCOPE_DEFAULT_CHAT_MODEL);
      assert.equal(config.chatBaseUrl, DASHSCOPE_COMPATIBLE_BASE_URL);
      assert.equal(config.embeddingProvider, "openai");
      assert.equal(config.embeddingApiKey, "dashscope-key");
      assert.equal(config.embeddingModel, DASHSCOPE_DEFAULT_EMBEDDING_MODEL);
      assert.equal(config.embeddingBaseUrl, DASHSCOPE_COMPATIBLE_BASE_URL);
      assert.equal(
        config.embeddingDimension,
        DASHSCOPE_DEFAULT_EMBEDDING_DIMENSION,
      );
    },
  );
});

test("getRagConfig prefers RAG_EMBEDDING_DIMENSIONS over the singular alias", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      DASHSCOPE_API_KEY: "dashscope-key",
      RAG_EMBEDDING_DIMENSIONS: "768",
      RAG_EMBEDDING_DIMENSION: "512",
    },
    () => {
      const config = getRagConfig();
      assert.equal(config.embeddingDimension, 768);
    },
  );
});

test("getRagConfig selects the Ark plug from RAG_PROVIDER", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      RAG_PROVIDER: "ark",
      ARK_API_KEY: "ark-key",
      RAG_CHAT_MODEL: "ark-endpoint-id",
      DASHSCOPE_API_KEY: undefined,
      RAG_CHAT_API_KEY: undefined,
      RAG_CHAT_BASE_URL: undefined,
      RAG_EMBEDDING_API_KEY: undefined,
      RAG_EMBEDDING_MODEL: undefined,
      RAG_EMBEDDING_BASE_URL: undefined,
      RAG_EMBEDDING_DIMENSIONS: undefined,
      RAG_EMBEDDING_PROVIDER: undefined,
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.ragProvider, "ark");
      assert.equal(config.embeddingProvider, "ark");
      assert.equal(config.embeddingTransport, "openai");
      assert.equal(config.embeddingPath, "embeddings/multimodal");
      assert.equal(config.chatApiKey, "ark-key");
      assert.equal(config.chatModel, "ark-endpoint-id");
      assert.equal(
        config.chatBaseUrl,
        "https://ark.cn-beijing.volces.com/api/plan/v3",
      );
      assert.equal(config.embeddingModel, "doubao-embedding-vision");
      assert.equal(
        config.embeddingBaseUrl,
        "https://ark.cn-beijing.volces.com/api/plan/v3",
      );
      assert.equal(config.embeddingDimension, 1024);
    },
  );
});

test("getRagConfig defaults embedding, chat, and vector operations to separate bounded timeouts", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      DASHSCOPE_API_KEY: "dashscope-key",
      RAG_EMBEDDING_TIMEOUT_MS: undefined,
      RAG_CHAT_TIMEOUT_MS: undefined,
      RAG_VECTOR_TIMEOUT_MS: undefined,
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.embeddingTimeoutMs, 15_000);
      assert.equal(config.chatTimeoutMs, 45_000);
      assert.equal(config.vectorTimeoutMs, 10_000);
    },
  );
});

test("getRagConfig accepts positive timeout overrides", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      DASHSCOPE_API_KEY: "dashscope-key",
      RAG_EMBEDDING_TIMEOUT_MS: "1200",
      RAG_CHAT_TIMEOUT_MS: "3400",
      RAG_VECTOR_TIMEOUT_MS: "5600",
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.embeddingTimeoutMs, 1200);
      assert.equal(config.chatTimeoutMs, 3400);
      assert.equal(config.vectorTimeoutMs, 5600);
    },
  );
});

test("getRagConfig rejects non-positive timeout overrides in favor of bounded defaults", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      DASHSCOPE_API_KEY: "dashscope-key",
      RAG_EMBEDDING_TIMEOUT_MS: "0",
      RAG_CHAT_TIMEOUT_MS: "-1",
      RAG_VECTOR_TIMEOUT_MS: "not-a-number",
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.embeddingTimeoutMs, 15_000);
      assert.equal(config.chatTimeoutMs, 45_000);
      assert.equal(config.vectorTimeoutMs, 10_000);
    },
  );
});

test("getRagConfig enables the ingest retrieval gate by default at a 0.9 hit-rate floor", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      DASHSCOPE_API_KEY: "dashscope-key",
      RAG_INGEST_GATE: undefined,
      RAG_INGEST_GATE_MIN_HIT_RATE: undefined,
    },
    () => {
      const config = getRagConfig();

      assert.equal(config.ingestGateEnabled, true);
      assert.equal(config.ingestGateMinHitRate, 0.9);
    },
  );
});

test("getRagConfig disables the ingest gate only for the exact off switch", () => {
  const credentials = {
    RAG_MILVUS_ADDRESS: "https://milvus.example.com",
    DASHSCOPE_API_KEY: "dashscope-key",
  };

  withEnv({ ...credentials, RAG_INGEST_GATE: "off" }, () => {
    assert.equal(getRagConfig().ingestGateEnabled, false);
  });

  ["on", "OFF", "Off", "false", "0", ""].forEach((value) => {
    withEnv({ ...credentials, RAG_INGEST_GATE: value }, () => {
      assert.equal(
        getRagConfig().ingestGateEnabled,
        true,
        `RAG_INGEST_GATE=${JSON.stringify(value)} must leave the gate enabled`,
      );
    });
  });
});

test("getRagConfig keeps a zero ingest gate hit rate instead of treating it as unset", () => {
  withEnv(
    {
      RAG_MILVUS_ADDRESS: "https://milvus.example.com",
      DASHSCOPE_API_KEY: "dashscope-key",
      RAG_INGEST_GATE_MIN_HIT_RATE: "0",
    },
    () => {
      assert.equal(
        getRagConfig().ingestGateMinHitRate,
        0,
        "a 0 floor must survive rather than falling back through a falsy check",
      );
    },
  );
});

test("getRagConfig accepts in-range ingest gate hit rates up to the 1 boundary", () => {
  const credentials = {
    RAG_MILVUS_ADDRESS: "https://milvus.example.com",
    DASHSCOPE_API_KEY: "dashscope-key",
  };

  [
    ["0.75", 0.75],
    ["1", 1],
  ].forEach(([value, expected]) => {
    withEnv({ ...credentials, RAG_INGEST_GATE_MIN_HIT_RATE: value }, () => {
      assert.equal(
        getRagConfig().ingestGateMinHitRate,
        expected,
        `RAG_INGEST_GATE_MIN_HIT_RATE=${value} must survive as ${expected}`,
      );
    });
  });
});

test("getRagConfig rejects out-of-range or non-numeric ingest gate hit rates", () => {
  const credentials = {
    RAG_MILVUS_ADDRESS: "https://milvus.example.com",
    DASHSCOPE_API_KEY: "dashscope-key",
  };

  ["1.5", "-0.1", "abc", ""].forEach((value) => {
    withEnv({ ...credentials, RAG_INGEST_GATE_MIN_HIT_RATE: value }, () => {
      assert.equal(
        getRagConfig().ingestGateMinHitRate,
        0.9,
        `RAG_INGEST_GATE_MIN_HIT_RATE=${JSON.stringify(value)} must fall back to 0.9`,
      );
    });
  });
});

test("corpus root prefers an explicit environment override", () => {
  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: { RAG_CORPUS_ROOT: "/srv/leaseqa-corpus" },
      serverRoot: "/repo/.worktrees/server-engineering",
      existsFn: () => false,
    }),
    "/srv/leaseqa-corpus",
  );
  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: { RAG_CORPUS_ROOT: "/srv/leaseqa-corpus" },
      serverRoot: "/repo/server",
      existsFn: () => true,
    }),
    "/srv/leaseqa-corpus",
    "an explicit override must win over a corpus committed in the repository",
  );
});

test("corpus root discovery works from the original checkout and an isolated worktree", () => {
  const corpusRoot = "/repo/resources/rag-corpus/mass tenant rights";
  const existsFn = (candidate) => candidate === corpusRoot;

  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: {},
      serverRoot: "/repo/server",
      existsFn,
    }),
    corpusRoot,
  );
  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: {},
      serverRoot: "/repo/.worktrees/server-engineering",
      existsFn,
    }),
    corpusRoot,
  );
});

test("corpus root prefers the copy committed inside the server repository", () => {
  const inRepoRoot = "/repo/server/resources/rag-corpus/mass tenant rights";
  const workspaceRoot = "/repo/resources/rag-corpus/mass tenant rights";
  const existsFn = (candidate) =>
    candidate === inRepoRoot || candidate === workspaceRoot;

  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: {},
      serverRoot: "/repo/server",
      existsFn,
    }),
    inRepoRoot,
    "a stale workspace copy must never shadow the committed corpus",
  );
});

test("corpus root finds the committed corpus from an isolated worktree", () => {
  const worktreeRoot =
    "/repo/server/.claude/worktrees/feature/resources/rag-corpus/mass tenant rights";
  const existsFn = (candidate) => candidate === worktreeRoot;

  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: {},
      serverRoot: "/repo/server/.claude/worktrees/feature",
      existsFn,
    }),
    worktreeRoot,
  );
});

test("corpus root falls back to the in-repository location when nothing exists", () => {
  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: {},
      serverRoot: "/repo/server",
      existsFn: () => false,
    }),
    "/repo/server/resources/rag-corpus/mass tenant rights",
  );
});

// A sibling worktree's corpus is reachable only by descending, and the walk only
// ascends. Pinned so the loop cannot start matching siblings and silently ingest
// another branch's corpus.
test("corpus root never selects a sibling worktree's corpus", () => {
  const siblingRoot =
    "/repo/server/.claude/worktrees/other/resources/rag-corpus/mass tenant rights";
  const existsFn = (candidate) => candidate === siblingRoot;

  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: {},
      serverRoot: "/repo/server/.claude/worktrees/feature",
      existsFn,
    }),
    "/repo/server/.claude/worktrees/feature/resources/rag-corpus/mass tenant rights",
    "a sibling worktree is not an ancestor, so it must never be reachable",
  );
});

test("corpus root tests the filesystem root exactly once and terminates", () => {
  const fromRoot = [];
  assert.equal(
    ragConfig.resolveCorpusRoot({
      env: {},
      serverRoot: "/",
      existsFn: (candidate) => {
        fromRoot.push(candidate);
        return false;
      },
    }),
    "/resources/rag-corpus/mass tenant rights",
  );
  assert.deepEqual(
    fromRoot,
    ["/resources/rag-corpus/mass tenant rights"],
    "path.dirname('/') is '/', so the loop must break instead of spinning",
  );

  const fromNested = [];
  ragConfig.resolveCorpusRoot({
    env: {},
    serverRoot: "/a/b",
    existsFn: (candidate) => {
      fromNested.push(candidate);
      return false;
    },
  });
  assert.deepEqual(
    fromNested,
    [
      "/a/b/resources/rag-corpus/mass tenant rights",
      "/a/resources/rag-corpus/mass tenant rights",
      "/resources/rag-corpus/mass tenant rights",
    ],
    "every ancestor including the filesystem root is tested, each exactly once",
  );
});

test("zhipu's scope-check band comes from the preset unless RAG_SCOPE_CHECK_BELOW moves it or turns it off", () => {
  const zhipu = {
    RAG_MILVUS_ADDRESS: "https://milvus.example.com",
    RAG_PROVIDER: "zhipu",
    ZHIPU_API_KEY: "zhipu-key",
    RAG_MIN_RERANK_SCORE: undefined,
    RAG_SCOPE_CHECK_BELOW: undefined,
  };
  withEnv(zhipu, () => {
    const config = getRagConfig();
    assert.equal(config.minRerankScore, 15.1);
    assert.equal(config.scopeCheckBelow, 17.5);
  });
  withEnv({ ...zhipu, RAG_SCOPE_CHECK_BELOW: "18" }, () => {
    assert.equal(getRagConfig().scopeCheckBelow, 18);
  });
  withEnv({ ...zhipu, RAG_SCOPE_CHECK_BELOW: "off" }, () => {
    assert.equal(getRagConfig().scopeCheckBelow, null);
  });
  // No preset band on another provider's scale.
  withEnv({ ...zhipu, RAG_PROVIDER: "dashscope", DASHSCOPE_API_KEY: "dashscope-key" }, () => {
    assert.equal(getRagConfig().scopeCheckBelow, null);
  });
});
