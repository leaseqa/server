import {
  questionTargetsBookletSource,
  questionTargetsLeadChapter,
  questionTargetsTemplateSource,
  rankKnowledgeChunks,
} from "./retrievalPolicy.js";

const UPLOAD_SOURCE_PATTERN =
  /\b(?:my|the)\s+(?:lease|contract|agreement|document|pdf|file|form)\b|\b(?:lease|contract|agreement)\s+says\b|\b(?:this|uploaded)\s+(?:lease|contract|agreement|document|pdf|file|form)\b|\bclause\b/i;
const HANDBOOK_SUPPORT_PATTERN =
  /\b(?:tenant-rights handbook|handbook|legal|legality|lawful|law|rules?|rights?|protections?|consistent|match(?:es|ing)?)\b/i;

const getChunkKey = (item) =>
  item.id ||
  [
    item.source_group,
    item.source_name,
    item.chapter_ref,
    String(item.text || "").slice(0, 160),
  ].join("::");

const dedupeById = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = getChunkKey(item);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

const sortByScoreDescending = (items) =>
  [...items].sort((left, right) => (right.score || 0) - (left.score || 0));

export const questionTargetsUploadedSource = (question) =>
  UPLOAD_SOURCE_PATTERN.test(question || "");

export const questionNeedsHandbookSupport = (question) =>
  questionTargetsUploadedSource(question) && HANDBOOK_SUPPORT_PATTERN.test(question || "");

const hasUploadedClauseSupport = (chunks) =>
  (chunks || []).some((chunk) => ["upload", "text"].includes(String(chunk.source_group || "")));

const hasHandbookSourceSupport = (chunks) =>
  (chunks || []).some((chunk) =>
    ["chapters", "handouts", "forms", "booklets"].includes(
      String(chunk.source_group || ""),
    ),
  );

export const selectCitationChunks = ({
  question,
  sessionChunks,
  knowledgeChunks,
  limit = 6,
}) => {
  const prioritizeUploadedSource = questionTargetsUploadedSource(question);
  const requireHandbookSupport = questionNeedsHandbookSupport(question);
  const rankedSessionChunks = sortByScoreDescending(sessionChunks || []);
  const rankedKnowledgeChunks = rankKnowledgeChunks(question, knowledgeChunks || []);

  if (requireHandbookSupport) {
    const leadingChunks = [];
    if (rankedSessionChunks[0]) {
      leadingChunks.push(rankedSessionChunks[0]);
    }
    if (rankedKnowledgeChunks[0]) {
      leadingChunks.push(rankedKnowledgeChunks[0]);
    }
    const remainder = prioritizeUploadedSource
      ? [...rankedSessionChunks.slice(1), ...rankedKnowledgeChunks.slice(1)]
      : [...rankedKnowledgeChunks.slice(1), ...rankedSessionChunks.slice(1)];

    return dedupeById([...leadingChunks, ...remainder]).slice(0, limit);
  }

  const orderedChunks = prioritizeUploadedSource
    ? [...rankedSessionChunks, ...rankedKnowledgeChunks]
    : [...rankedKnowledgeChunks, ...rankedSessionChunks];

  return dedupeById(orderedChunks).slice(0, limit);
};

export const hasReliableCitationSupport = ({ question, citationChunks }) => {
  const firstChunk = citationChunks?.[0];
  if (!firstChunk) {
    return false;
  }

  if (questionNeedsHandbookSupport(question)) {
    return (
      hasUploadedClauseSupport(citationChunks) &&
      hasHandbookSourceSupport(citationChunks)
    );
  }

  if (questionTargetsUploadedSource(question)) {
    return ["upload", "text"].includes(firstChunk.source_group);
  }

  if (questionTargetsTemplateSource(question)) {
    return firstChunk.source_group === "forms";
  }

  if (questionTargetsBookletSource(question)) {
    return firstChunk.source_group === "booklets";
  }

  if (questionTargetsLeadChapter(question)) {
    return (
      firstChunk.chapter_ref === "9" ||
      /lead/i.test(String(firstChunk.source_name || ""))
    );
  }

  return ["chapters", "handouts", "forms", "booklets"].includes(
    firstChunk.source_group,
  );
};
