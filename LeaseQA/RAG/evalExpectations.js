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

// A case names one source group, or a list when the passage it asks about
// lives in more than one, such as a chapter and that chapter's handout. Chapter
// refs and name tokens apply to whichever group matched.
export const expectedSourceGroupsOf = (evalCase) =>
  Array.isArray(evalCase?.expectedSourceGroup)
    ? evalCase.expectedSourceGroup
    : [evalCase?.expectedSourceGroup];

export const matchesExpectation = (evalCase, candidate) => {
  if (
    !candidate ||
    !expectedSourceGroupsOf(evalCase).includes(candidate.sourceGroup)
  ) {
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
