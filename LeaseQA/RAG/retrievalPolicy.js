// Every source group in the corpus manifest (retrievalPolicy.test.js checks
// this list against corpus_manifest.csv). Each group is searched separately so
// the long chapters cannot crowd a short form or booklet out of the candidate
// pool; ranking, not the group, decides what the model is shown.
export const KNOWLEDGE_SOURCE_GROUPS = [
  "chapters",
  "handouts",
  "forms",
  "booklets",
  "appendix",
];

const CONTEXTUAL_REFERENCE_PATTERN =
  /\b(?:this|that|it|they|them|these|those)\b|\b(?:clause|provision|term|section|paragraph|part)\b/i;
const VAGUE_FOLLOW_UP_PATTERN =
  /^\s*(?:what do you mean|what does that mean|what does this mean|can you explain|why|how so|what about that)\??\s*$/i;

const normalizeSnippet = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const countWords = (value) =>
  normalizeSnippet(value)
    .split(" ")
    .filter(Boolean).length;

const shouldAttachSourceContext = (question) =>
  VAGUE_FOLLOW_UP_PATTERN.test(question || "") ||
  CONTEXTUAL_REFERENCE_PATTERN.test(question || "") ||
  /\bis (?:this|that|it)\s+legal\b/i.test(question || "");

const shouldAttachHistoryContext = (question) =>
  VAGUE_FOLLOW_UP_PATTERN.test(question || "") ||
  (CONTEXTUAL_REFERENCE_PATTERN.test(question || "") &&
    countWords(question) <= 6) ||
  /\bis that enforceable\b/i.test(question || "") ||
  /^\s*(?:is it legal|is that legal|is this legal)\??\s*$/i.test(question || "");

export const buildRetrievalQuestion = ({
                                         question,
                                         sourceTextPreview = "",
                                         messages = [],
                                       }) => {
  const parts = [normalizeSnippet(question)];
  const recentUserTurns = messages
    .filter((message) => message?.role === "user")
    .slice(-2)
    .map((message) => normalizeSnippet(message.content))
    .filter(Boolean);

  if ( shouldAttachHistoryContext(question) && recentUserTurns.length > 0 ) {
    parts.push(...recentUserTurns);
  }

  if ( shouldAttachSourceContext(question) ) {
    const normalizedPreview = normalizeSnippet(sourceTextPreview);
    if ( normalizedPreview ) {
      parts.push(normalizedPreview);
    }
  }

  return [...new Set(parts.filter(Boolean))].join("\n");
};

export const buildKnowledgeSearchPlan = (config) =>
  KNOWLEDGE_SOURCE_GROUPS.map((group) => ({
    group,
    limit: config.candidatesPerGroup,
  }));

const toRerankDocument = (chunk) => {
  const title = normalizeSnippet(chunk.title_hint || chunk.source_name);
  const text = String(chunk.text || "").trim();
  return title ? `${title}\n${text}` : text;
};

const sortByDescending = (chunks, scoreOf) =>
  [...chunks].sort((left, right) => scoreOf(right) - scoreOf(left));

// Puts every candidate, uploaded text and corpus alike, in order of how well it
// answers the question. The reranker reads each (question, chunk) pair
// together; without one, or when it fails, only the hybrid search's fused
// score is left.
export const rankEvidence = async ({
                                     question,
                                     chunks,
                                     rerankClient,
                                     onRerankError,
                                   }) => {
  if ( rerankClient ) {
    if ( chunks.length === 0 ) {
      return { rankedBy: "rerank", chunks: [] };
    }
    try {
      const scores = await rerankClient.rerank({
        query: question,
        documents: chunks.map(toRerankDocument),
      });
      return {
        rankedBy: "rerank",
        chunks: sortByDescending(
          chunks.map((chunk, index) => ({
            ...chunk,
            rerank_score: scores[index],
          })),
          (chunk) => chunk.rerank_score,
        ),
      };
    } catch ( error ) {
      onRerankError?.(error);
    }
  }

  return {
    rankedBy: "fusion",
    chunks: sortByDescending(chunks, (chunk) => chunk.score || 0),
  };
};

// The evidence the model may cite, best first, or none, so the answer
// abstains, when even the best chunk is too weak to answer from. A reranker
// scores every (question, chunk) pair on one scale, so its floor is a single
// number (RAG_MIN_RERANK_SCORE). Fused RRF scores have no such scale: a chunk
// matched by both the dense and the sparse ranker scores ~0.033 and one
// matched by a single ranker ~0.016, so the fallback only asks that the best
// chunk was matched by both (~0.025).
export const selectEvidence = ({ ranking, config }) => {
  const best = ranking.chunks[0];
  const [bestScore, floor] =
    ranking.rankedBy === "rerank"
      ? [best?.rerank_score, config.minRerankScore]
      : [best?.score || 0, config.minSupportScore];
  return Number.isFinite(bestScore) && bestScore >= floor
    ? ranking.chunks.slice(0, config.evidenceLimit)
    : [];
};

// The best reranked score among handbook chunks, or null without one. The
// renter's own text matches whatever they ask about it ("can I deduct the rent
// in this lease from my taxes?"), so only the handbook's score says whether
// the question is about renting.
export const bestHandbookScore = (ranking) => {
  const best = ranking.chunks.find((chunk) => KNOWLEDGE_SOURCE_GROUPS.includes(chunk.source_group));
  return Number.isFinite(best?.rerank_score) ? best.rerank_score : null;
};

// Whether the evidence is strong enough to show the model but too weak to say
// the question is about renting at all. On the eval set out-of-scope questions
// (divorce, unemployment) and answerable ones (no heat, lockouts) both score
// from the floor up to RAG_SCOPE_CHECK_BELOW, so there the chat model decides
// first. The floor is held against the best chunk, which may be the renter's
// own text; the bound against the handbook's best. Only a reranker's scale has
// such a band.
export const needsScopeCheck = ({ ranking, config }) => {
  const bestScore = ranking.chunks[0]?.rerank_score;
  if (
    ranking.rankedBy !== "rerank" ||
    !Number.isFinite(config.scopeCheckBelow) ||
    !(Number.isFinite(bestScore) && bestScore >= config.minRerankScore)
  ) {
    return false;
  }
  const handbookScore = bestHandbookScore(ranking);
  return handbookScore === null || handbookScore < config.scopeCheckBelow;
};
