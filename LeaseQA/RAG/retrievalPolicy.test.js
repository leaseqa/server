import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { parseManifestCsv } from "./corpusManifest.js";
import { resolveCorpusRoot } from "./config.js";
import {
  buildKnowledgeSearchPlan,
  buildRetrievalQuestion,
  KNOWLEDGE_SOURCE_GROUPS,
  rankEvidence,
  selectEvidence,
} from "./retrievalPolicy.js";

const config = {
  candidatesPerGroup: 10,
  evidenceLimit: 6,
  minRerankScore: 0.2,
  minSupportScore: 0.025,
};

const chunk = (id, overrides = {}) => ({
  id,
  source_group: "chapters",
  source_name: `${id}.pdf`,
  title_hint: "",
  text: `text of ${id}`,
  score: 0.02,
  ...overrides,
});

const rerankWith = (scoresById) => {
  const calls = [];
  return {
    calls,
    client: {
      rerank: async ({ query, documents }) => {
        calls.push({ query, documents });
        return documents.map((document) => {
          const id = Object.keys(scoresById).find((key) =>
            document.includes(`text of ${key}`),
          );
          return scoresById[id];
        });
      },
    },
  };
};

test("the searched source groups are exactly the corpus manifest's groups", async () => {
  const manifestPath = path.join(resolveCorpusRoot(), "corpus_manifest.csv");
  const manifest = parseManifestCsv(await fs.readFile(manifestPath, "utf8"));

  assert.deepEqual(
    [...KNOWLEDGE_SOURCE_GROUPS].sort(),
    [...new Set(manifest.map((item) => item.source_group))].sort(),
  );
});

test("buildKnowledgeSearchPlan searches every group alike, whatever the question", () => {
  assert.deepEqual(
    buildKnowledgeSearchPlan(config),
    KNOWLEDGE_SOURCE_GROUPS.map((group) => ({ group, limit: 10 })),
  );
});

test("rankEvidence orders uploaded text and corpus chunks on the reranker's one scale", async () => {
  const { client, calls } = rerankWith({ corpus: 0.4, clause: 0.9, weak: 0.1 });

  const ranking = await rankEvidence({
    question: "Is this deposit clause legal?",
    chunks: [
      chunk("corpus", { title_hint: "Chapter 3: Security Deposits", score: 0.033 }),
      chunk("clause", { source_group: "upload", title_hint: "lease.pdf", score: 0.016 }),
      chunk("weak", { score: 0.03 }),
    ],
    rerankClient: client,
  });

  assert.equal(ranking.rankedBy, "rerank");
  assert.deepEqual(ranking.chunks.map((item) => item.id), ["clause", "corpus", "weak"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, "Is this deposit clause legal?");
  assert.equal(calls[0].documents[0], "Chapter 3: Security Deposits\ntext of corpus");
});

test("rankEvidence keeps the fused order when no reranker is configured", async () => {
  const ranking = await rankEvidence({
    question: "q",
    chunks: [chunk("low", { score: 0.016 }), chunk("high", { score: 0.033 })],
    rerankClient: null,
  });

  assert.equal(ranking.rankedBy, "fusion");
  assert.deepEqual(ranking.chunks.map((item) => item.id), ["high", "low"]);
});

test("rankEvidence falls back to the fused order and reports it when the reranker fails", async () => {
  const failures = [];
  const ranking = await rankEvidence({
    question: "q",
    chunks: [chunk("low", { score: 0.016 }), chunk("high", { score: 0.033 })],
    rerankClient: {
      rerank: async () => {
        throw Object.assign(new Error("rerank down"), { code: "RAG_RERANK_FAILED" });
      },
    },
    onRerankError: (error) => failures.push(error.code),
  });

  assert.equal(ranking.rankedBy, "fusion");
  assert.deepEqual(ranking.chunks.map((item) => item.id), ["high", "low"]);
  assert.deepEqual(failures, ["RAG_RERANK_FAILED"]);
});

test("rankEvidence does not call the reranker when retrieval found nothing", async () => {
  const { client, calls } = rerankWith({});

  const ranking = await rankEvidence({ question: "q", chunks: [], rerankClient: client });

  assert.deepEqual(ranking, { rankedBy: "rerank", chunks: [] });
  assert.equal(calls.length, 0);
});

test("selectEvidence keeps the top reranked chunks, at most the evidence limit, once the best clears the floor", () => {
  const chunks = [0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.1].map((rerankScore, index) =>
    chunk(`c${index}`, { rerank_score: rerankScore }),
  );

  const evidence = selectEvidence({ ranking: { rankedBy: "rerank", chunks }, config });

  assert.deepEqual(evidence.map((item) => item.id), ["c0", "c1", "c2", "c3", "c4", "c5"]);
});

test("selectEvidence abstains when no reranked chunk clears the floor", () => {
  const evidence = selectEvidence({
    ranking: {
      rankedBy: "rerank",
      chunks: [chunk("a", { rerank_score: 0.19 }), chunk("b", { rerank_score: 0.05 })],
    },
    config,
  });

  assert.deepEqual(evidence, []);
});

test("selectEvidence leaves the choice among the top chunks to the model once the best clears the floor", () => {
  const evidence = selectEvidence({
    ranking: {
      rankedBy: "rerank",
      chunks: [chunk("strong", { rerank_score: 0.8 }), chunk("weak", { rerank_score: 0.05 })],
    },
    config,
  });

  assert.deepEqual(evidence.map((item) => item.id), ["strong", "weak"]);
});

test("selectEvidence reads the floor on the reranker's own scale, raw logits included", () => {
  const ranking = {
    rankedBy: "rerank",
    chunks: [chunk("a", { rerank_score: 16.2 }), chunk("b", { rerank_score: 9.1 })],
  };

  assert.deepEqual(selectEvidence({ ranking, config: { ...config, minRerankScore: 17 } }), []);
  assert.deepEqual(
    selectEvidence({ ranking, config: { ...config, minRerankScore: 15 } }).map((item) => item.id),
    ["a", "b"],
  );
});

test("selectEvidence on the fused fallback abstains unless the best chunk matched both rankers", () => {
  const single = selectEvidence({
    ranking: { rankedBy: "fusion", chunks: [chunk("a", { score: 0.0164 })] },
    config,
  });
  const both = selectEvidence({
    ranking: { rankedBy: "fusion", chunks: [chunk("a", { score: 0.0328 }), chunk("b", { score: 0.01 })] },
    config,
  });

  assert.deepEqual(single, []);
  assert.deepEqual(both.map((item) => item.id), ["a", "b"]);
});

test("buildRetrievalQuestion appends source preview for clause legality questions", () => {
  const query = buildRetrievalQuestion({
    question: "Is this clause legal?",
    sourceTextPreview:
      "The landlord must return the security deposit within 30 days after the tenant moves out, minus any lawful deductions.",
    messages: [],
  });

  assert.match(query, /security deposit/i);
  assert.match(query, /30 days/i);
});

test("buildRetrievalQuestion appends prior user turn for vague follow-up questions", () => {
  const query = buildRetrievalQuestion({
    question: "What do you mean?",
    sourceTextPreview:
      "The landlord must return the security deposit within 30 days after the tenant moves out, minus any lawful deductions.",
    messages: [
      {
        role: "user",
        content: "Is this clause legal?",
      },
      {
        role: "assistant",
        content: "I could not answer that reliably.",
      },
    ],
  });

  assert.match(query, /what do you mean\?/i);
  assert.match(query, /is this clause legal\?/i);
  assert.match(query, /security deposit/i);
});

test("buildRetrievalQuestion appends prior user turn for referential follow-up questions", () => {
  const query = buildRetrievalQuestion({
    question: "Can they do that?",
    sourceTextPreview:
      "The landlord must return the security deposit within 30 days after the tenant moves out, minus any lawful deductions.",
    messages: [
      {
        role: "user",
        content: "If I move out early, does the 30-day deadline still start right away?",
      },
      {
        role: "assistant",
        content: "No, the deadline may run from the last day of the lease.",
      },
    ],
  });

  assert.match(query, /can they do that\?/i);
  assert.match(
    query,
    /if i move out early, does the 30-day deadline still start right away\?/i,
  );
  assert.match(query, /security deposit/i);
});

test("buildRetrievalQuestion keeps clause context for enforceability questions", () => {
  const query = buildRetrievalQuestion({
    question: "Is that enforceable?",
    sourceTextPreview:
      "The tenant waives all rights to challenge unlawful fees or deductions from the security deposit.",
    messages: [
      {
        role: "user",
        content: "My lease says I waive my rights to challenge unlawful fees.",
      },
    ],
  });

  assert.match(query, /is that enforceable\?/i);
  assert.match(query, /waive my rights to challenge unlawful fees/i);
  assert.match(query, /security deposit/i);
});

