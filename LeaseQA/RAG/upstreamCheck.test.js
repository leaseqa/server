import test from "node:test";
import assert from "node:assert/strict";

import {
  CHALLENGE_MARKERS,
  GROUP_INDEX_PAGES,
  diffAgainstManifest,
  extractPdfCandidates,
  isChallengePage,
  matchCandidateForRow,
} from "./upstreamCheck.js";

// Every literal below is a real value: revisions and source_urls come from
// corpus_manifest.csv, hrefs and surplus PDFs from the 2026-08-23 recon.
const FILES = "https://www.masslegalhelp.org/sites/default/files";

const row = (overrides = {}) => ({
  file_name: "ch03_security_deposits.pdf",
  source_type: "chapter",
  source_group: "chapters",
  file_path: "pdf/chapters/ch03_security_deposits.pdf",
  source_url:
    "https://www.masslegalhelp.org/housing-apartments-shelter/security-deposits/chapter-3-security-deposits-and-last-months-rent",
  pdf_url: "",
  upstream_revision: "03 Security Deposits 2025- Updated 8-13-25",
  ...overrides,
});

const CH03_HREF = `${FILES}/2025-10/03%20Security%20Deposits%202025-%20Updated%208-13-25.pdf`;
const CH04_HREF = `${FILES}/2025-02/04%20Tenancies%202025.pdf`;

const observed = (candidates, overrides = {}) => ({
  status: "ok",
  pageUrl: GROUP_INDEX_PAGES.chapters[0],
  candidates,
  ...overrides,
});

test("a Cloudflare interstitial is recognized as a challenge", () => {
  assert.equal(isChallengePage("Just a moment...", "Checking your browser"), true);
  assert.equal(
    isChallengePage("Attention Required! | Cloudflare", "Verify you are human"),
    true,
  );
  assert.equal(
    isChallengePage("Chapter 3: Security Deposits", "Your landlord must..."),
    false,
  );
  assert.ok(CHALLENGE_MARKERS.length > 0);
});

test("the index pages cover exactly the five manifest source groups", () => {
  assert.deepEqual(Object.keys(GROUP_INDEX_PAGES).sort(), [
    "appendix",
    "booklets",
    "chapters",
    "forms",
    "handouts",
  ]);

  // The appendix hub holds no PDFs, so it is crawled as four sub-pages.
  assert.equal(GROUP_INDEX_PAGES.appendix.length, 4);
  for ( const [group, pages] of Object.entries(GROUP_INDEX_PAGES) ) {
    assert.ok(Array.isArray(pages), `${group} must be a list of pages`);
    for ( const page of pages ) {
      assert.equal(new URL(page).origin, "https://www.masslegalhelp.org");
    }
  }

  // 5 groups, 8 page loads -- not 81. Eight rather than nine because the
  // appendix hub itself is never fetched: it carries no PDFs, so its four
  // sub-pages replace it instead of being crawled in addition to it.
  assert.equal(Object.values(GROUP_INDEX_PAGES).flat().length, 8);
  assert.ok(
    !Object.values(GROUP_INDEX_PAGES).flat().some((page) => page.endsWith("/appendix")),
  );
});

test("the revision is read from the decoded href basename, not the link text", () => {
  const candidates = extractPdfCandidates([
    // The real anchor: a human title in the text, the revision in the filename.
    { href: CH03_HREF, text: "Chapter 3: Security Deposits" },
    { href: "https://www.masslegalhelp.org/x/chapter-4", text: "Next chapter" },
    { href: `${FILES}/2025-01/Handout%2017%20-%20Condos%2C%202025.PDF?download=1`, text: "Handout 17" },
  ]);

  assert.deepEqual(candidates, [
    {
      href: CH03_HREF,
      revision: "03 Security Deposits 2025- Updated 8-13-25",
      text: "Chapter 3: Security Deposits",
    },
    {
      href: `${FILES}/2025-01/Handout%2017%20-%20Condos%2C%202025.PDF?download=1`,
      revision: "Handout 17 - Condos, 2025",
      text: "Handout 17",
    },
  ]);
});

test("scraped text is stripped of anything the manifest CSV cannot round-trip", () => {
  const [candidate] = extractPdfCandidates([
    {
      href: `${FILES}/2025-10/03%20Security%0ADeposits%202025-%20Updated%208-13-25.pdf`,
      text: "  Chapter 3:\r\n Security Deposits \t",
    },
  ]);

  // A newline in a revision would split a manifest row in two; a control
  // character makes planManifestRefresh throw. Neither may survive scraping.
  assert.equal(candidate.revision, "03 Security Deposits 2025- Updated 8-13-25");
  assert.equal(candidate.text, "Chapter 3: Security Deposits");
  for ( const value of [candidate.revision, candidate.text] ) {
    assert.ok(!/[\u0000-\u001f\u007f]/.test(value), "no control character may survive");
    assert.ok(!/\s\s/.test(value), "no doubled whitespace may survive");
  }
});

test("the same PDF linked twice yields one candidate", () => {
  const candidates = extractPdfCandidates([
    { href: CH03_HREF, text: "Chapter 3: Security Deposits" },
    { href: CH03_HREF, text: "Download the PDF" },
  ]);

  assert.equal(candidates.length, 1);
});

test("a malformed percent escape falls back to the raw basename", () => {
  const [candidate] = extractPdfCandidates([
    { href: `${FILES}/2025-10/100%%20Broken.pdf`, text: "Broken link" },
  ]);

  assert.equal(candidate.revision, "100%%20Broken");
});

test("a row with a known pdf_url matches on basename across a month move", () => {
  const match = matchCandidateForRow(
    row({ pdf_url: `${FILES}/2025-02/03%20Security%20Deposits%202025-%20Updated%208-13-25.pdf` }),
    extractPdfCandidates([
      { href: CH04_HREF, text: "Chapter 4: Tenancies" },
      // Same filename, re-uploaded under a later month directory.
      { href: CH03_HREF, text: "Chapter 3: Security Deposits" },
    ]),
  );

  assert.equal(match.href, CH03_HREF);
});

test("a row with no pdf_url matches on the revision, as on the first run", () => {
  const match = matchCandidateForRow(
    row(),
    extractPdfCandidates([
      { href: CH04_HREF, text: "Chapter 4: Tenancies" },
      { href: CH03_HREF, text: "Chapter 3: Security Deposits" },
    ]),
  );

  assert.equal(match.href, CH03_HREF);
  assert.equal(match.revision, "03 Security Deposits 2025- Updated 8-13-25");
});

test("a renamed PDF is still matched through its unique revision prefix", () => {
  const renamed = `${FILES}/2026-01/03%20Security%20Deposits%202026%20-%20Updated%201-15-26.pdf`;
  const match = matchCandidateForRow(
    row(),
    extractPdfCandidates([
      { href: CH04_HREF, text: "Chapter 4: Tenancies" },
      { href: renamed, text: "Chapter 3: Security Deposits" },
    ]),
  );

  assert.equal(match.href, renamed);
});

// The only real prefix collision in the corpus. Both revisions are verbatim
// from corpus_manifest.csv and normalize to the same 12-character prefix.
const ANSWER_ROW = row({
  file_name: "booklet_3_answer.pdf",
  source_group: "booklets",
  upstream_revision: "Booklet 3 Answer 2024",
});
const INSTRUCTIONS_ROW = row({
  file_name: "booklet_3_answer_instructions_and_form.pdf",
  source_group: "booklets",
  upstream_revision: "Booklet 3_Answer_Instructions and Form 2025",
});
const INSTRUCTIONS_HREF = `${FILES}/2026-01/Booklet%203_Answer_Instructions%20and%20Form%202025.pdf`;

test("an ambiguous prefix returns null instead of picking a side", () => {
  const match = matchCandidateForRow(
    ANSWER_ROW,
    extractPdfCandidates([
      { href: `${FILES}/2026-01/Booklet%203%20Answer%202026.pdf`, text: "Booklet 3" },
      { href: INSTRUCTIONS_HREF, text: "Booklet 3 instructions" },
    ]),
    [ANSWER_ROW, INSTRUCTIONS_ROW],
  );

  assert.equal(match, null);
});

test("a row whose own PDF is gone does not claim its prefix sibling's", () => {
  // Only the sibling's PDF is still published, so counting candidates would
  // find exactly one prefix match and hand it over with full confidence.
  const candidates = extractPdfCandidates([
    { href: INSTRUCTIONS_HREF, text: "Booklet 3 instructions" },
  ]);

  assert.equal(
    matchCandidateForRow(ANSWER_ROW, candidates, [ANSWER_ROW, INSTRUCTIONS_ROW]),
    null,
  );

  // Symmetric: the survivor must not be claimed from the other direction either.
  const answerOnly = extractPdfCandidates([
    { href: `${FILES}/2026-01/Booklet%203%20Answer%202024.pdf`, text: "Booklet 3" },
  ]);
  assert.equal(
    matchCandidateForRow(INSTRUCTIONS_ROW, answerOnly, [ANSWER_ROW, INSTRUCTIONS_ROW]),
    null,
  );
});

test("the orphaned row is reported not_found, never as its sibling's revision", () => {
  const diff = diffAgainstManifest({
    rows: [ANSWER_ROW, INSTRUCTIONS_ROW],
    observations: {
      booklets: observed(
        extractPdfCandidates([
          { href: INSTRUCTIONS_HREF, text: "Booklet 3 instructions" },
        ]),
        { pageUrl: GROUP_INDEX_PAGES.booklets[0] },
      ),
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  // Without the sibling guard this row came back as changed, promoting the
  // sibling's revision and URL onto the wrong manifest row.
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.notFound, ["booklet_3_answer.pdf"]);
  assert.equal(diff.entries["booklet_3_answer.pdf"].status, "not_found");
  assert.equal(
    diff.entries["booklet_3_answer.pdf"].revision,
    "Booklet 3 Answer 2024",
  );
  assert.equal(diff.entries["booklet_3_answer.pdf"].pdfUrl, "");
  // The sibling still matches its own PDF exactly.
  assert.equal(
    diff.entries["booklet_3_answer_instructions_and_form.pdf"].status,
    "ok",
  );
});

test("an unmatchable row returns null rather than a wrong guess", () => {
  assert.equal(
    matchCandidateForRow(
      row(),
      extractPdfCandidates([
        { href: `${FILES}/2025-02/18%20Foreclosure%202025.pdf`, text: "Chapter 18" },
      ]),
    ),
    null,
  );
});

test("observations are keyed by source group, so one page load serves many rows", () => {
  const diff = diffAgainstManifest({
    rows: [
      row(),
      row({
        file_name: "ch04_tenancies.pdf",
        upstream_revision: "04 Tenancies 2025",
      }),
    ],
    observations: {
      chapters: observed(
        extractPdfCandidates([
          { href: CH03_HREF, text: "Chapter 3: Security Deposits" },
          { href: CH04_HREF, text: "Chapter 4: Tenancies" },
        ]),
      ),
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  assert.equal(diff.checkedAt, "2026-09-01T12:00:00.000Z");
  assert.deepEqual(diff.changed, []);
  assert.equal(diff.entries["ch03_security_deposits.pdf"].status, "ok");
  assert.equal(diff.entries["ch04_tenancies.pdf"].status, "ok");
  // The live href carries the upload-month directory Task 5 left empty.
  assert.equal(diff.entries["ch03_security_deposits.pdf"].pdfUrl, CH03_HREF);
  assert.equal(
    diff.entries["ch03_security_deposits.pdf"].pageUrl,
    GROUP_INDEX_PAGES.chapters[0],
  );
});

test("a changed revision is reported with both sides", () => {
  const renamed = `${FILES}/2026-01/03%20Security%20Deposits%202026%20-%20Updated%201-15-26.pdf`;
  const diff = diffAgainstManifest({
    rows: [row()],
    observations: {
      chapters: observed(
        extractPdfCandidates([{ href: renamed, text: "Chapter 3: Security Deposits" }]),
      ),
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  assert.deepEqual(diff.changed, [
    {
      fileName: "ch03_security_deposits.pdf",
      previousRevision: "03 Security Deposits 2025- Updated 8-13-25",
      nextRevision: "03 Security Deposits 2026 - Updated 1-15-26",
    },
  ]);
  assert.equal(diff.entries["ch03_security_deposits.pdf"].status, "changed");
  assert.equal(diff.entries["ch03_security_deposits.pdf"].pdfUrl, renamed);
});

test("surplus site PDFs are ignored while a missing row is still reported", () => {
  const diff = diffAgainstManifest({
    rows: [
      row({
        file_name: "booklet_1_representing_yourself.pdf",
        source_group: "booklets",
        upstream_revision: "Booklet 1 Representing Yourself 2025",
      }),
      row({
        file_name: "booklet_2_housing_code_checklist.pdf",
        source_group: "booklets",
        upstream_revision: "Booklet 2 Housing Code Checklist 2025",
      }),
    ],
    observations: {
      booklets: observed(
        extractPdfCandidates([
          {
            href: `${FILES}/2025-04/Booklet%201%20Representing%20Yourself%202025.pdf`,
            text: "Booklet 1",
          },
          // Real surplus: a stray booklet and a translation, neither in our corpus.
          {
            href: `${FILES}/2025-04/lt1-booklet-2-housing-code-checklist_0.pdf`,
            text: "Housing code checklist",
          },
          {
            href: `${FILES}/2025-04/Booklet%202%20Spanish%202025.pdf`,
            text: "Booklet 2 (Spanish)",
          },
        ]),
        { pageUrl: GROUP_INDEX_PAGES.booklets[0] },
      ),
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  assert.deepEqual(diff.notFound, ["booklet_2_housing_code_checklist.pdf"]);
  assert.deepEqual(diff.blocked, []);
  assert.deepEqual(diff.changed, []);
  assert.equal(diff.entries["booklet_1_representing_yourself.pdf"].status, "ok");
  assert.equal(diff.entries["booklet_2_housing_code_checklist.pdf"].status, "not_found");
  // An unmatched row keeps what the manifest already knew.
  assert.equal(
    diff.entries["booklet_2_housing_code_checklist.pdf"].revision,
    "Booklet 2 Housing Code Checklist 2025",
  );
  assert.equal(Object.keys(diff.entries).length, 2);
});

test("a group with no observation at all is blocked, not missing", () => {
  const diff = diffAgainstManifest({
    rows: [row()],
    observations: {},
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  assert.deepEqual(diff.blocked, ["ch03_security_deposits.pdf"]);
  assert.deepEqual(diff.notFound, []);
  assert.equal(diff.entries["ch03_security_deposits.pdf"].status, "blocked");
  // Falls back to the row's own page so a human knows where to look.
  assert.equal(diff.entries["ch03_security_deposits.pdf"].pageUrl, row().source_url);
});

test("a partly blocked group cannot downgrade an unseen row to not_found", () => {
  const diff = diffAgainstManifest({
    rows: [
      row({
        file_name: "appendix_02_glossary.pdf",
        source_group: "appendix",
        upstream_revision: "Glossary-2025",
      }),
      row({
        file_name: "appendix_03_directory.pdf",
        source_group: "appendix",
        upstream_revision: "Directory Legal Tactics 2025 - Update 8-26-2025",
      }),
    ],
    observations: {
      // One of the four appendix sub-pages failed; the rest still gave candidates.
      appendix: observed(
        extractPdfCandidates([
          { href: `${FILES}/2025-04/Glossary-2025.pdf`, text: "Glossary" },
        ]),
        { status: "blocked", pageUrl: GROUP_INDEX_PAGES.appendix[0] },
      ),
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  assert.equal(diff.entries["appendix_02_glossary.pdf"].status, "ok");
  assert.deepEqual(diff.blocked, ["appendix_03_directory.pdf"]);
  assert.deepEqual(diff.notFound, []);
});

test("a group that yielded no PDFs at all reports blocked, not 18 deletions", () => {
  // The contract observeGroup relies on: it marks a group blocked when the
  // merged candidate list is empty, because a hub with zero PDFs is an outage,
  // never upstream having deleted every document in the group at once.
  const rows = ["ch01_moving_in.pdf", "ch02_tenant_screening.pdf", "ch03_security_deposits.pdf"].map(
    (file_name) => row({ file_name }),
  );

  const diff = diffAgainstManifest({
    rows,
    observations: { chapters: observed([], { status: "blocked" }) },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  assert.equal(diff.blocked.length, 3);
  assert.deepEqual(diff.notFound, []);
  assert.deepEqual(diff.changed, []);
});

test("the diff sanitizes revisions the manifest serializer would reject", () => {
  const diff = diffAgainstManifest({
    rows: [row()],
    observations: {
      chapters: observed([
        {
          // A hand-built observation that never passed through
          // extractPdfCandidates must still not poison the manifest.
          href: `${FILES}/2026-01/x.pdf\u0000`,
          revision: "03 Security\r\nDeposits 2026\u0007",
          text: "Chapter 3",
        },
      ]),
    },
    now: new Date("2026-09-01T12:00:00.000Z"),
  });

  const entry = diff.entries["ch03_security_deposits.pdf"];
  assert.equal(entry.revision, "03 Security Deposits 2026");
  assert.equal(entry.pdfUrl, `${FILES}/2026-01/x.pdf`);
  for ( const value of [entry.revision, entry.pdfUrl] ) {
    assert.ok(!/[\r\n]/.test(value), "a line break would split a manifest row");
    assert.ok(!/[\u0000-\u001f\u007f]/.test(value), "planManifestRefresh rejects these");
  }
});
