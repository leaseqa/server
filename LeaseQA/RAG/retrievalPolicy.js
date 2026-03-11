const DEFAULT_GROUP_PRIORITY = ["chapters", "handouts", "forms", "booklets", "appendix"];
const TEMPLATE_GROUP_PRIORITY = ["forms", "chapters", "handouts", "booklets", "appendix"];
const BOOKLET_GROUP_PRIORITY = ["booklets", "chapters", "handouts", "forms", "appendix"];

const TEMPLATE_PATTERN = /\b(?:template|form|notice|letter|draft|sample|write)\b/i;
const BOOKLET_PATTERN =
  /\b(?:summary process|late answer|answer form|motion|discovery|appeal|stay|dismiss|default|affidavit of indigency|housing code checklist)\b/i;
const EVICTION_PATTERN =
  /\b(?:eviction|notice to quit|summary process|court date)\b/i;
const LEAD_PATTERN = /\b(?:lead|delead|poisoning|child under 6)\b/i;
const ORGANIZING_PATTERN = /\b(?:organizing|organize|retaliat(?:e|ion)|tenant association|collective bargaining)\b/i;
const CONTEXTUAL_REFERENCE_PATTERN =
  /\b(?:this|that|it|they|them|these|those)\b|\b(?:clause|provision|term|section|paragraph|part)\b/i;
const VAGUE_FOLLOW_UP_PATTERN =
  /^\s*(?:what do you mean|what does that mean|what does this mean|can you explain|why|how so|what about that)\??\s*$/i;

const normalizeSnippet = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();

const shouldAttachSourceContext = (question) =>
  questionTargetsTemplateSource(question) ||
  VAGUE_FOLLOW_UP_PATTERN.test(question || "") ||
  CONTEXTUAL_REFERENCE_PATTERN.test(question || "") ||
  /\bis (?:this|that|it)\s+legal\b/i.test(question || "");

const shouldAttachHistoryContext = (question) =>
  VAGUE_FOLLOW_UP_PATTERN.test(question || "") ||
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

  if (shouldAttachHistoryContext(question) && recentUserTurns.length > 0) {
    parts.push(...recentUserTurns);
  }

  if (shouldAttachSourceContext(question)) {
    const normalizedPreview = normalizeSnippet(sourceTextPreview);
    if (normalizedPreview) {
      parts.push(normalizedPreview);
    }
  }

  return [...new Set(parts.filter(Boolean))].join("\n");
};

export const questionTargetsTemplateSource = (question) =>
  TEMPLATE_PATTERN.test(question || "") && !/notice to quit/i.test(question || "");

export const questionTargetsBookletSource = (question) =>
  BOOKLET_PATTERN.test(question || "");

export const questionTargetsLeadChapter = (question) =>
  LEAD_PATTERN.test(question || "");

export const questionTargetsOrganizingChapter = (question) =>
  ORGANIZING_PATTERN.test(question || "");

const questionTargetsEvictionProcedures = (question) =>
  EVICTION_PATTERN.test(question || "");

const getKnowledgeGroupPriority = (question) => {
  if (questionTargetsTemplateSource(question)) {
    return TEMPLATE_GROUP_PRIORITY;
  }
  if (questionTargetsBookletSource(question)) {
    return BOOKLET_GROUP_PRIORITY;
  }
  return DEFAULT_GROUP_PRIORITY;
};

export const buildKnowledgeSearchPlan = (question, config) => {
  const primaryLimit = Math.max(4, Math.ceil(config.knowledgeTopK / 2));
  const secondaryLimit = Math.max(2, Math.ceil(config.knowledgeTopK / 3));

  if (questionTargetsLeadChapter(question)) {
    return [
      { group: "chapters", limit: primaryLimit, chapterRef: "9" },
      { group: "handouts", limit: 2, chapterRef: "9" },
      { group: "chapters", limit: secondaryLimit },
      { group: "handouts", limit: 2 },
      { group: "forms", limit: 1 },
    ];
  }

  if (questionTargetsOrganizingChapter(question)) {
    return [
      { group: "chapters", limit: primaryLimit, chapterRef: "10" },
      { group: "handouts", limit: 2, chapterRef: "10" },
      { group: "chapters", limit: secondaryLimit },
      { group: "handouts", limit: 2 },
      { group: "forms", limit: 1 },
    ];
  }

  if (questionTargetsTemplateSource(question)) {
    return [
      { group: "forms", limit: primaryLimit },
      { group: "chapters", limit: secondaryLimit },
      { group: "handouts", limit: 2 },
      { group: "booklets", limit: 1 },
    ];
  }

  if (questionTargetsBookletSource(question)) {
    return [
      { group: "booklets", limit: primaryLimit },
      { group: "chapters", limit: secondaryLimit },
      { group: "handouts", limit: 2 },
      { group: "forms", limit: 1 },
    ];
  }

  if (questionTargetsEvictionProcedures(question)) {
    return [
      { group: "chapters", limit: primaryLimit },
      { group: "booklets", limit: 3 },
      { group: "handouts", limit: 2 },
      { group: "forms", limit: 1 },
      { group: "appendix", limit: 1 },
    ];
  }

  return [
    { group: "chapters", limit: primaryLimit },
    { group: "handouts", limit: 2 },
    { group: "forms", limit: 1 },
    { group: "appendix", limit: 1 },
  ];
};

const buildGroupPriorityMap = (question) =>
  new Map(getKnowledgeGroupPriority(question).map((group, index) => [group, index]));

const isLeadPreferredChunk = (question, chunk) =>
  questionTargetsLeadChapter(question) &&
  (String(chunk.chapter_ref || "") === "9" ||
    /lead/i.test(String(chunk.source_name || "")));

const isOrganizingPreferredChunk = (question, chunk) =>
  questionTargetsOrganizingChapter(question) &&
  (String(chunk.chapter_ref || "") === "10" ||
    /organiz/i.test(String(chunk.source_name || "")));

const isHousingChecklistPreferredChunk = (question, chunk) =>
  questionTargetsBookletSource(question) &&
  /housing code checklist/i.test(question || "") &&
  /housing_code_checklist/i.test(String(chunk.source_name || ""));

export const rankKnowledgeChunks = (question, chunks) => {
  const groupPriorityMap = buildGroupPriorityMap(question);

  return [...chunks].sort((left, right) => {
    const leftLeadBoost = isLeadPreferredChunk(question, left) ? 1 : 0;
    const rightLeadBoost = isLeadPreferredChunk(question, right) ? 1 : 0;
    if (leftLeadBoost !== rightLeadBoost) {
      return rightLeadBoost - leftLeadBoost;
    }

    const leftOrganizingBoost = isOrganizingPreferredChunk(question, left) ? 1 : 0;
    const rightOrganizingBoost = isOrganizingPreferredChunk(question, right) ? 1 : 0;
    if (leftOrganizingBoost !== rightOrganizingBoost) {
      return rightOrganizingBoost - leftOrganizingBoost;
    }

    const leftHousingChecklistBoost = isHousingChecklistPreferredChunk(
      question,
      left,
    )
      ? 1
      : 0;
    const rightHousingChecklistBoost = isHousingChecklistPreferredChunk(
      question,
      right,
    )
      ? 1
      : 0;
    if (leftHousingChecklistBoost !== rightHousingChecklistBoost) {
      return rightHousingChecklistBoost - leftHousingChecklistBoost;
    }

    const groupDelta =
      (groupPriorityMap.get(left.source_group) ?? 99) -
      (groupPriorityMap.get(right.source_group) ?? 99);
    if (groupDelta !== 0) {
      return groupDelta;
    }

    return (right.score || 0) - (left.score || 0);
  });
};
