const asText = (value) => String(value ?? "");

// The text a case pastes into its session, the way a renter pastes a clause,
// or null when it has none.
export const pastedSourceTextOf = (evalCase) =>
  typeof evalCase?.sourceText === "string" && evalCase.sourceText.trim()
    ? evalCase.sourceText
    : null;

export const normalizeCitationExpectationInput = (citation) => ({
  sourceGroup: asText(citation?.sourceGroup),
  sourceName: asText(citation?.sourceName),
  chapterRef: asText(citation?.chapterRef),
});

export const normalizeChunkExpectationInput = (chunk) => ({
  sourceGroup: asText(chunk?.source_group),
  sourceName: asText(chunk?.source_name),
  chapterRef: asText(chunk?.chapter_ref),
});

// Whether a retrieved chunk or a cited source is the passage a case names. The
// ingest gate and the retrieval report use this as it stands: they check that
// the ingest made that exact passage retrievable.
export const matchesExpectation = (evalCase, candidate) => {
  if ( !candidate || candidate.sourceGroup !== evalCase?.expectedSourceGroup ) {
    return false;
  }
  if (
    Array.isArray(evalCase.expectedChapterRefs) &&
    evalCase.expectedChapterRefs.length > 0 &&
    !evalCase.expectedChapterRefs.includes(candidate.chapterRef)
  ) {
    return false;
  }
  if (
    Array.isArray(evalCase.expectedSourceNameIncludes) &&
    evalCase.expectedSourceNameIncludes.length > 0
  ) {
    const sourceName = candidate.sourceName.toLowerCase();
    return evalCase.expectedSourceNameIncludes.some((token) =>
      sourceName.includes(asText(token).toLowerCase()),
    );
  }
  return true;
};

// Whether an answer's citation meets the case. The handbook ships each chapter
// with a handout on the same ground, and either is a sound source for a renter
// (owner's call, 2026-11-09), so citing chapter N's handout meets a case that
// names chapter N. Only answers get this. A handout cannot show that the ingest
// made the chapter itself retrievable, which is what the gate asks.
export const matchesAnswerCitation = (evalCase, citation) =>
  matchesExpectation(evalCase, citation) ||
  (evalCase?.expectedSourceGroup === "chapters" &&
    matchesExpectation({ ...evalCase, expectedSourceGroup: "handouts" }, citation));

// Answers and phrasings are compared in one spelling: lower case, straight
// quotes, hyphens and dashes as spaces, single spaces. The model writes
// "month’s" as often as "month's", and "one-month limit" as often as "one
// month limit".
const normalizeAnswerText = (text) =>
  asText(text)
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    // The hyphen, then U+2010 to U+2015: hyphen, figure, en and em dashes.
    .replace(/[-‐-―]/g, " ")
    .replace(/\s+/g, " ");

// The points a case requires that the answer never states, by label. A point
// lists the phrasings that count for it, and any one of them does. Citing the
// right chapter does not show the answer says what the chapter says: a first
// answer that cited chapter 3 and called the deposit cap unclear passed the
// source check on 2026-11-08.
export const missingRequiredPoints = (evalCase, answer) => {
  const text = normalizeAnswerText(answer);
  const points = Array.isArray(evalCase?.requiredPoints) ? evalCase.requiredPoints : [];
  return points
    .filter((point) => !(point?.anyOf || []).some((phrase) => text.includes(normalizeAnswerText(phrase))))
    .map((point) => asText(point?.point));
};
