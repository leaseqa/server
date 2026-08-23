// Detects when MassLegalHelp revises the corpus PDFs. Observes and reports
// only: it downloads nothing, and it must never attempt to defeat, solve, or
// evade a bot check. A challenged page is recorded as "blocked" and left for a
// human.
//
// The site publishes each source_group on a single index page, so the whole
// 81-row corpus is covered by 8 page loads rather than 81.

export const CHALLENGE_MARKERS = [
  "just a moment",
  "checking your browser",
  "enable javascript and cookies to continue",
  "verify you are human",
  "attention required! | cloudflare",
];

// Scraped strings reach corpus_manifest.csv by way of upstream_state.json and
// planManifestRefresh, which throws on any control character, and
// serializeManifestCsv, which throws on \r or \n. Collapse both classes at the
// point of scraping: a newline inside a PDF filename would otherwise split a
// manifest row in two and hand ingest a phantom file_path. \s alone is not
// enough -- NUL and DEL are not whitespace but are still rejected downstream.
const CONTROL_OR_SPACE_PATTERN = /[\s\u0000-\u001f\u007f]+/g;

const collapseWhitespace = (value) =>
  String(value ?? "")
    .replace(CONTROL_OR_SPACE_PATTERN, " ")
    .trim();

// A URL cannot carry a raw space, so drop the run instead of collapsing it to
// one; substituting a space would produce a link that no longer resolves.
const stripWhitespace = (value) =>
  String(value ?? "").replace(CONTROL_OR_SPACE_PATTERN, "");

export const isChallengePage = (pageTitle, bodyText) => {
  const haystack =
    `${collapseWhitespace(pageTitle)} ${collapseWhitespace(bodyText)}`.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => haystack.includes(marker));
};

const HOUSING = "https://www.masslegalhelp.org/housing-apartments-shelter";

// One entry per manifest source_group. The appendix is a list of four
// sub-pages because its own hub page carries no PDFs at all.
export const GROUP_INDEX_PAGES = {
  chapters: [`${HOUSING}/tenants-rights/chapter-pdfs-legal-tactics`],
  handouts: [`${HOUSING}/tenants-rights/handout-pdfs-legal-tactics`],
  forms: [`${HOUSING}/taking-your-landlord-court/housing-forms-checklists-and-letters`],
  booklets: [`${HOUSING}/eviction/booklets-representing-yourself-eviction`],
  appendix: [
    `${HOUSING}/tenants-rights/using-legal-tactics`,
    `${HOUSING}/tenants-rights/acknowledgments`,
    `${HOUSING}/tenants-rights/glossary`,
    `${HOUSING}/tenants-rights/directory`,
  ],
};

const PDF_HREF_PATTERN = /\.pdf(\?|#|$)/i;

const decodedBasename = (href) => {
  const raw = String(href ?? "");
  let pathname;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    pathname = raw.split(/[?#]/)[0];
  }
  const basename = pathname.split("/").pop() || "";
  try {
    return decodeURIComponent(basename);
  } catch {
    // A malformed escape such as %zz is not worth aborting the crawl over;
    // the raw basename still identifies the file well enough to match on.
    return basename;
  }
};

// The official revision string lives in the PDF filename, not the link text.
// Link text is a human title ("Chapter 3: Security Deposits"); the decoded
// basename minus ".pdf" is what the manifest stores as upstream_revision.
const revisionFromHref = (href) =>
  collapseWhitespace(decodedBasename(href).replace(/\.pdf$/i, ""));

export const extractPdfCandidates = (anchors) => {
  const seen = new Set();

  return (anchors || [])
    .filter((anchor) => PDF_HREF_PATTERN.test(String(anchor?.href ?? "")))
    .flatMap((anchor) => {
      const href = stripWhitespace(anchor.href);
      if ( seen.has(href) ) {
        return [];
      }
      seen.add(href);
      return [
        {
          href,
          revision: revisionFromHref(href),
          text: collapseWhitespace(anchor.text),
        },
      ];
    });
};

const normalizeRevision = (value) =>
  collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const REVISION_PREFIX_LENGTH = 12;

const revisionPrefix = (value) =>
  normalizeRevision(value).slice(0, REVISION_PREFIX_LENGTH);

// siblingRows are the other manifest rows in the same source_group. They are
// needed to keep the prefix fallback honest: see the comment on its use below.
export const matchCandidateForRow = (row, candidates, siblingRows = []) => {
  const pool = candidates || [];

  if ( row?.pdf_url ) {
    // Compare filenames, not full URLs: a re-upload moves the file into a new
    // /<YYYY-MM>/ directory without renaming it, and that is the same PDF.
    const target = normalizeRevision(revisionFromHref(row.pdf_url));
    const byFileName = pool.find(
      (candidate) => normalizeRevision(candidate.revision) === target,
    );
    if ( byFileName ) {
      return byFileName;
    }
  }

  const revision = normalizeRevision(row?.upstream_revision);
  if ( !revision ) {
    return null;
  }

  const exact = pool.find(
    (candidate) => normalizeRevision(candidate.revision) === revision,
  );
  if ( exact ) {
    return exact;
  }

  // Upstream renames the file when it revises it ("...2025" -> "...2026"), so
  // exact matching alone would report every real change as not_found -- the
  // one case this tool exists to catch. Accept a leading-prefix match only
  // when it is unambiguous.
  const prefix = revision.slice(0, REVISION_PREFIX_LENGTH);
  const byPrefix = pool.filter((candidate) =>
    normalizeRevision(candidate.revision).startsWith(prefix),
  );
  if ( byPrefix.length !== 1 ) {
    return null;
  }

  // Counting candidates is not sufficient on its own. Two manifest rows can
  // share a prefix (booklet_3_answer and booklet_3_answer_instructions_and_form
  // really do), and while both their PDFs are on the page the count catches it.
  // Delete one PDF and the survivor becomes the only prefix match, so the
  // orphaned row would claim its sibling's file with full confidence and
  // promote the sibling's revision and URL onto the wrong manifest row. Ask
  // instead whether any sibling row could also own this candidate, which is
  // true whether or not that sibling's own PDF is still published.
  const claimedBySibling = siblingRows.some((sibling) => {
    if ( !sibling || sibling.file_name === row.file_name ) {
      return false;
    }
    const siblingPrefix = revisionPrefix(sibling.upstream_revision);
    return (
      siblingPrefix !== "" &&
      normalizeRevision(byPrefix[0].revision).startsWith(siblingPrefix)
    );
  });

  return claimedBySibling ? null : byPrefix[0];
};

// observations is keyed by source_group -- one crawled index page serves every
// row in its group. Matching is deliberately asymmetric: the site carries PDFs
// our corpus does not (a stray booklet on the forms page, four non-English
// translations on the booklets page), so an unmatched candidate is ignored
// silently while an unmatched manifest row is always reported.
export const diffAgainstManifest = ({ rows, observations, now = new Date() }) => {
  const entries = {};
  const changed = [];
  const blocked = [];
  const notFound = [];

  // Every row is in hand here, so a row's group siblings are free to supply and
  // let matchCandidateForRow reject a candidate another row could equally own.
  const rowsByGroup = new Map();
  for ( const row of rows ) {
    const group = rowsByGroup.get(row.source_group) || [];
    group.push(row);
    rowsByGroup.set(row.source_group, group);
  }

  for ( const row of rows ) {
    const observation = observations?.[row.source_group];
    const candidate = matchCandidateForRow(
      row,
      observation?.candidates,
      rowsByGroup.get(row.source_group),
    );
    const pageUrl = observation?.pageUrl || row.source_url || "";

    if ( !candidate ) {
      // A page we never read cannot tell us the row is gone. Only a group
      // observed end to end can claim not_found; a group where any page failed
      // stays blocked, so a transient network error is never mistaken for
      // upstream deleting a document.
      const status =
        !observation || observation.status === "blocked" ? "blocked" : "not_found";
      ( status === "blocked" ? blocked : notFound ).push(row.file_name);
      entries[row.file_name] = {
        pdfUrl: stripWhitespace(row.pdf_url),
        revision: collapseWhitespace(row.upstream_revision),
        status,
        pageUrl,
      };
      continue;
    }

    const nextRevision = collapseWhitespace(candidate.revision);
    const isChanged =
      normalizeRevision(nextRevision) !== normalizeRevision(row.upstream_revision);

    if ( isChanged ) {
      changed.push({
        fileName: row.file_name,
        previousRevision: collapseWhitespace(row.upstream_revision),
        nextRevision,
      });
    }

    entries[row.file_name] = {
      // The live href carries the /<YYYY-MM>/ upload directory, a second
      // freshness signal that the manifest's pdf_url column was left empty for.
      pdfUrl: stripWhitespace(candidate.href),
      revision: nextRevision,
      status: isChanged ? "changed" : "ok",
      pageUrl,
    };
  }

  return { checkedAt: now.toISOString(), entries, changed, blocked, notFound };
};
