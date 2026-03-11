import {
  questionTargetsBookletSource,
  questionTargetsLeadChapter,
  questionTargetsTemplateSource,
  rankKnowledgeChunks,
} from "./retrievalPolicy.js";

const UPLOAD_SOURCE_PATTERN =
  /\b(?:my|the)\s+(?:lease|contract|agreement|document|pdf|file|form)\b|\b(?:lease|contract|agreement)\s+says\b|\b(?:this|uploaded)\s+(?:lease|contract|agreement|document|pdf|file|form)\b|\bclause\b/i;

const dedupeById = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) {
      return false;
    }
    seen.add(item.id);
    return true;
  });
};

const sortByScoreDescending = (items) =>
  [...items].sort((left, right) => (right.score || 0) - (left.score || 0));

export const questionTargetsUploadedSource = (question) =>
  UPLOAD_SOURCE_PATTERN.test(question || "");

export const selectCitationChunks = ({
  question,
  sessionChunks,
  knowledgeChunks,
  limit = 6,
}) => {
  const prioritizeUploadedSource = questionTargetsUploadedSource(question);
  const rankedSessionChunks = sortByScoreDescending(sessionChunks || []);
  const rankedKnowledgeChunks = rankKnowledgeChunks(question, knowledgeChunks || []);

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
