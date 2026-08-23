const asText = (value) => String(value ?? "");

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

export const matchesExpectation = (evalCase, candidate) => {
  if ( !candidate || candidate.sourceGroup !== evalCase.expectedSourceGroup ) {
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
