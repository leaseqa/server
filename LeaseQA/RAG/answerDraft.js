// The chat model answers with one JSON object (see prompt.js). While that
// object is still arriving, this reads the parts a renter can already read,
// the summary and each bullet's text, and reports only what is new since the
// previous call. Support ids stay out of it: they are checked against the
// evidence once the whole object is in (finalizeAssistantCitations), and the
// finished answer replaces this draft.

/**
 * Parse a JSON object that may be cut off at any character. Open strings and
 * brackets are closed and a half-written escape is dropped. A cut that still
 * leaves invalid JSON (a key whose value has not started) returns null; the
 * next chunk normally completes it. Anything after the object, such as a
 * closing code fence, is ignored.
 */
export const parsePartialJsonObject = (text) => {
  const start = String(text || "").indexOf("{");
  if ( start === -1 ) {
    return null;
  }
  const source = text.slice(start);
  const closers = [];
  let inString = false;
  let escapeStart = -1;
  let unicodeDigitsLeft = 0;
  let end = source.length;

  for ( let index = 0; index < source.length; index += 1 ) {
    const char = source[index];
    if ( inString ) {
      if ( unicodeDigitsLeft > 0 ) {
        unicodeDigitsLeft -= 1;
        if ( unicodeDigitsLeft === 0 ) {
          escapeStart = -1;
        }
      } else if ( escapeStart !== -1 ) {
        if ( char === "u" ) {
          unicodeDigitsLeft = 4;
        } else {
          escapeStart = -1;
        }
      } else if ( char === "\\" ) {
        escapeStart = index;
      } else if ( char === "\"" ) {
        inString = false;
      }
      continue;
    }
    if ( char === "\"" ) {
      inString = true;
    } else if ( char === "{" ) {
      closers.push("}");
    } else if ( char === "[" ) {
      closers.push("]");
    } else if ( char === "}" || char === "]" ) {
      if ( closers.pop() !== char ) {
        return null;
      }
      if ( closers.length === 0 ) {
        end = index + 1;
        break;
      }
    }
  }

  let candidate = source.slice(0, end);
  if ( closers.length > 0 ) {
    if ( inString ) {
      if ( escapeStart !== -1 ) {
        candidate = candidate.slice(0, escapeStart);
      }
      candidate += "\"";
    }
    candidate += closers.reverse().join("");
  }

  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
};

const readText = (value) => (typeof value === "string" ? value : "");

/**
 * Follows one model answer as it streams. update() takes the whole raw text so
 * far and returns the deltas it adds:
 *   { part: "summary", text }
 *   { part: "bullet", index, text }
 * A field only ever grows, so each delta appends to what the client already
 * shows.
 */
export const createDraftTracker = () => {
  let summary = "";
  const bullets = [];

  return {
    update(rawText) {
      const parsed = parsePartialJsonObject(rawText);
      if ( !parsed ) {
        return [];
      }

      const deltas = [];
      const nextSummary = readText(parsed.summary);
      if ( nextSummary.length > summary.length && nextSummary.startsWith(summary) ) {
        deltas.push({ part: "summary", text: nextSummary.slice(summary.length) });
        summary = nextSummary;
      }

      const nextBullets = Array.isArray(parsed.bullets) ? parsed.bullets : [];
      nextBullets.forEach((bullet, index) => {
        const previous = bullets[index] || "";
        const next = readText(bullet?.text);
        if ( next.length > previous.length && next.startsWith(previous) ) {
          deltas.push({ part: "bullet", index, text: next.slice(previous.length) });
          bullets[index] = next;
        }
      });

      return deltas;
    },
  };
};
