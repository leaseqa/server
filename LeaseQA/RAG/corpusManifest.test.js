import test from "node:test";
import assert from "node:assert/strict";

import {
  MANIFEST_COLUMNS,
  parseManifestCsv,
  planManifestRefresh,
  readManifestHeader,
  serializeManifestCsv,
} from "./corpusManifest.js";

const HEADER = MANIFEST_COLUMNS.join(",");

const row = (overrides = {}) => ({
  file_name: "ch03_security_deposits.pdf",
  title_hint: "03 Security Deposits 2025- Updated 8-13-25",
  source_type: "chapter",
  source_group: "chapters",
  chapter_ref: "3",
  priority: "P0",
  file_path: "pdf/chapters/ch03_security_deposits.pdf",
  source_url: "https://www.masslegalhelp.org/x/chapter-3",
  pdf_url: "https://www.masslegalhelp.org/files/ch03.pdf",
  content_sha256: "a".repeat(64),
  retrieved_at: "2026-03-01",
  upstream_revision: "03 Security Deposits 2025- Updated 8-13-25",
  ...overrides,
});

test("the canonical header keeps the original eight columns first", () => {
  assert.deepEqual(MANIFEST_COLUMNS.slice(0, 8), [
    "file_name",
    "title_hint",
    "source_type",
    "source_group",
    "chapter_ref",
    "priority",
    "file_path",
    "source_url",
  ]);
  assert.deepEqual(MANIFEST_COLUMNS.slice(8), [
    "pdf_url",
    "content_sha256",
    "retrieved_at",
    "upstream_revision",
  ]);
});

test("serialize then parse round-trips a row", () => {
  const original = [row()];
  const parsed = parseManifestCsv(serializeManifestCsv(original));

  assert.deepEqual(parsed, original);
});

test("serialization quotes values containing commas or quotes", () => {
  const text = serializeManifestCsv([
    row({ title_hint: 'Handout 17 - Condos, "revised"' }),
  ]);

  assert.match(text, /"Handout 17 - Condos, ""revised"""/);
  assert.deepEqual(parseManifestCsv(text)[0].title_hint, 'Handout 17 - Condos, "revised"');
});

test("serialization ends with exactly one trailing newline", () => {
  const text = serializeManifestCsv([row()]);

  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.endsWith("\n\n"), false);
  assert.equal(text.split("\n")[0], HEADER);
});

test("an unchanged corpus produces byte-identical output", () => {
  const rows = [row()];
  const before = serializeManifestCsv(rows);

  const plan = planManifestRefresh({
    rows,
    hashes: { "pdf/chapters/ch03_security_deposits.pdf": "a".repeat(64) },
    upstreamState: {
      entries: {
        "ch03_security_deposits.pdf": {
          pdfUrl: "https://cdn.example/new-location.pdf",
          revision: "03 Security Deposits 2025- Updated 11-02-25",
        },
      },
    },
    now: new Date("2026-09-01T00:00:00.000Z"),
  });

  assert.deepEqual(plan.changed, []);
  assert.equal(plan.unchanged, 1);
  assert.equal(serializeManifestCsv(plan.rows), before);
});

test("a whole migrated manifest survives parse, refresh and serialize byte-for-byte", () => {
  const before = [
    MANIFEST_COLUMNS.join(","),
    "appendix_00_using_legal_tactics.pdf,00 Using LegalTactics_2025,appendix,appendix,,P2,pdf/appendix/appendix_00_using_legal_tactics.pdf,https://www.masslegalhelp.org/x/using-legal-tactics,,"
      + `${"1".repeat(64)},2026-03-01,00 Using LegalTactics_2025`,
    'handout_ch17_condos.pdf,"Handout 17 - Condos, 2025",handout,handouts,17,P1,pdf/handouts/handout_ch17_condos.pdf,https://www.masslegalhelp.org/x/Condos%2C%202025.pdf,,'
      + `${"2".repeat(64)},2026-03-01,"Handout 17 - Condos, 2025"`,
    "ch03_security_deposits.pdf,03 Security Deposits 2025- Updated 8-13-25,chapter,chapters,3,P0,pdf/chapters/ch03_security_deposits.pdf,https://www.masslegalhelp.org/x/chapter-3,,"
      + `${"3".repeat(64)},2026-03-01,03 Security Deposits 2025- Updated 8-13-25`,
    "",
  ].join("\n");

  const rows = parseManifestCsv(before);
  const plan = planManifestRefresh({
    rows,
    hashes: {
      "pdf/appendix/appendix_00_using_legal_tactics.pdf": "1".repeat(64),
      "pdf/handouts/handout_ch17_condos.pdf": "2".repeat(64),
      "pdf/chapters/ch03_security_deposits.pdf": "3".repeat(64),
    },
    upstreamState: { entries: {} },
    now: new Date("2026-09-01T00:00:00.000Z"),
  });

  assert.deepEqual(plan.changed, []);
  assert.equal(plan.unchanged, 3);
  assert.equal(serializeManifestCsv(plan.rows), before);
  assert.equal(
    Buffer.compare(
      Buffer.from(serializeManifestCsv(plan.rows), "utf8"),
      Buffer.from(before, "utf8"),
    ),
    0,
  );
});

test("a changed hash refreshes retrieved_at and promotes upstream metadata", () => {
  const plan = planManifestRefresh({
    rows: [row()],
    hashes: { "pdf/chapters/ch03_security_deposits.pdf": "b".repeat(64) },
    upstreamState: {
      entries: {
        "ch03_security_deposits.pdf": {
          pdfUrl: "https://cdn.example/new-location.pdf",
          revision: "03 Security Deposits 2025- Updated 11-02-25",
        },
      },
    },
    now: new Date("2026-09-01T00:00:00.000Z"),
  });

  assert.deepEqual(plan.changed, [
    {
      fileName: "ch03_security_deposits.pdf",
      previousSha: "a".repeat(64),
      nextSha: "b".repeat(64),
    },
  ]);
  assert.equal(plan.rows[0].content_sha256, "b".repeat(64));
  assert.equal(plan.rows[0].retrieved_at, "2026-09-01");
  assert.equal(plan.rows[0].pdf_url, "https://cdn.example/new-location.pdf");
  assert.equal(
    plan.rows[0].upstream_revision,
    "03 Security Deposits 2025- Updated 11-02-25",
  );
});

test("a missing local file is reported instead of silently blanked", () => {
  assert.throws(
    () =>
      planManifestRefresh({
        rows: [row()],
        hashes: {},
        upstreamState: { entries: {} },
        now: new Date("2026-09-01T00:00:00.000Z"),
      }),
    /ch03_security_deposits\.pdf/,
  );
});

// A quoted line break is representable in RFC 4180 but not by parseManifestCsv,
// which splits on newlines before it is quote-aware. The serializer must refuse
// to write anything the parser cannot read back, or one scraped revision string
// silently splits a row in two and hands ingest a phantom file_path.
test("serialization refuses a value containing a line feed", () => {
  assert.throws(
    () => serializeManifestCsv([row({ upstream_revision: "rev\n2025" })]),
    /ch03_security_deposits\.pdf[\s\S]*upstream_revision/,
  );
});

test("serialization refuses a value containing a lone carriage return", () => {
  assert.throws(
    () => serializeManifestCsv([row({ upstream_revision: "rev 4\r" })]),
    /ch03_security_deposits\.pdf[\s\S]*upstream_revision/,
  );
});

test("serialization refuses a value containing a CRLF pair", () => {
  assert.throws(
    () => serializeManifestCsv([row({ pdf_url: "https://x/a.pdf\r\n" })]),
    /ch03_security_deposits\.pdf[\s\S]*pdf_url/,
  );
});

test("promoting an upstream revision with a line break is refused by file name", () => {
  assert.throws(
    () =>
      planManifestRefresh({
        rows: [row()],
        hashes: { "pdf/chapters/ch03_security_deposits.pdf": "b".repeat(64) },
        upstreamState: {
          entries: {
            "ch03_security_deposits.pdf": { revision: "March 2026\r\nrev 4" },
          },
        },
        now: new Date("2026-09-01T00:00:00.000Z"),
      }),
    /ch03_security_deposits\.pdf/,
  );
});

test("promoting an upstream pdf_url with a control character is refused by file name", () => {
  assert.throws(
    () =>
      planManifestRefresh({
        rows: [row()],
        hashes: { "pdf/chapters/ch03_security_deposits.pdf": "b".repeat(64) },
        upstreamState: {
          entries: {
            "ch03_security_deposits.pdf": {
              pdfUrl: "https://cdn.example/ch03.pdf\t",
            },
          },
        },
        now: new Date("2026-09-01T00:00:00.000Z"),
      }),
    /ch03_security_deposits\.pdf/,
  );
});

test("a clean upstream promotion is still accepted", () => {
  const plan = planManifestRefresh({
    rows: [row()],
    hashes: { "pdf/chapters/ch03_security_deposits.pdf": "b".repeat(64) },
    upstreamState: {
      entries: {
        "ch03_security_deposits.pdf": {
          pdfUrl: "https://cdn.example/ch03.pdf",
          revision: "March 2026 rev 4",
        },
      },
    },
    now: new Date("2026-09-01T00:00:00.000Z"),
  });

  assert.equal(plan.rows[0].pdf_url, "https://cdn.example/ch03.pdf");
  assert.equal(plan.rows[0].upstream_revision, "March 2026 rev 4");
});

// The three shapes the ingest path actually meets on disk. Pinned because
// ingestKnowledgeCorpus parses the manifest through this module.
test("a CRLF manifest parses the same as an LF one", () => {
  const lf = `${HEADER}\nfirst.pdf,First,chapter,chapters,1,P0,pdf/first.pdf,https://example.test/first,,${"c".repeat(64)},2026-03-01,First\n`;
  const crlf = lf.replaceAll("\n", "\r\n");

  assert.deepEqual(parseManifestCsv(crlf), parseManifestCsv(lf));
  assert.equal(parseManifestCsv(crlf).length, 1);
  assert.equal(parseManifestCsv(crlf)[0].upstream_revision, "First");
});

test("a row shorter than the header fills the missing columns with empty strings", () => {
  const rows = parseManifestCsv(
    `${HEADER}\nfirst.pdf,First,chapter,chapters,1,P0,pdf/first.pdf\n`,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].file_name, "first.pdf");
  assert.equal(rows[0].source_url, "");
  assert.equal(rows[0].content_sha256, "");
  assert.equal(rows[0].upstream_revision, "");
  assert.deepEqual(Object.keys(rows[0]), MANIFEST_COLUMNS);
});

test("trailing blank lines do not become rows", () => {
  const body = `first.pdf,First,chapter,chapters,1,P0,pdf/first.pdf,https://example.test/first,,${"c".repeat(64)},2026-03-01,First`;

  assert.equal(parseManifestCsv(`${HEADER}\n${body}\n`).length, 1);
  assert.equal(parseManifestCsv(`${HEADER}\n${body}\n\n`).length, 1);
  assert.equal(parseManifestCsv(`${HEADER}\n${body}\n\n\n`).length, 1);
  assert.equal(parseManifestCsv(`${HEADER}\n${body}\r\n\r\n`).length, 1);
  assert.deepEqual(
    parseManifestCsv(`${HEADER}\n${body}\n\n`),
    parseManifestCsv(`${HEADER}\n${body}\n`),
  );
});

test("readManifestHeader reads the real header, quotes and all", () => {
  assert.deepEqual(readManifestHeader(`${HEADER}\nignored\n`), MANIFEST_COLUMNS);
  assert.deepEqual(
    readManifestHeader(`${HEADER}\r\nignored\r\n`),
    MANIFEST_COLUMNS,
  );
  assert.deepEqual(readManifestHeader('"a,b",c\n1,2\n'), ["a,b", "c"]);
  assert.deepEqual(readManifestHeader(""), []);
});
