import test from "node:test";
import assert from "node:assert/strict";

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CHANGED_EXIT_CODE,
  INCONCLUSIVE_EXIT_CODE,
  OVERDUE_EXIT_CODE,
  formatIssueBody,
  formatIssueTitle,
  isSameReport,
  main,
  parseArgs,
} from "../../scripts/format-upstream-issue.js";

// Every literal below is a real value: file names and revisions come from
// corpus_manifest.csv, page and PDF URLs from the 2026-08-23 recon. The report
// shape is exactly what diffAgainstManifest returns.
const FILES = "https://www.masslegalhelp.org/sites/default/files";
const CHAPTERS_PAGE =
  "https://www.masslegalhelp.org/housing-apartments-shelter/tenants-rights/chapter-pdfs-legal-tactics";
const HANDOUTS_PAGE =
  "https://www.masslegalhelp.org/housing-apartments-shelter/tenants-rights/handout-pdfs-legal-tactics";

const report = (overrides = {}) => ({
  checkedAt: "2026-08-24T13:00:12.000Z",
  entries: {},
  changed: [],
  blocked: [],
  notFound: [],
  ...overrides,
});

const CH03_CHANGED = {
  fileName: "ch03_security_deposits.pdf",
  previousRevision: "03 Security Deposits 2025- Updated 8-13-25",
  nextRevision: "03 Security Deposits 2026 - Updated 1-9-26",
};

const CH03_ENTRY = {
  pdfUrl: `${FILES}/2026-01/03%20Security%20Deposits%202026%20-%20Updated%201-9-26.pdf`,
  revision: "03 Security Deposits 2026 - Updated 1-9-26",
  status: "changed",
  pageUrl: CHAPTERS_PAGE,
};

test("a changed run is framed as an upstream publication and shows both revisions", () => {
  const body = formatIssueBody({
    status: CHANGED_EXIT_CODE,
    report: report({
      changed: [CH03_CHANGED],
      entries: { [CH03_CHANGED.fileName]: CH03_ENTRY },
    }),
  });

  assert.match(body, /published changes/i);
  assert.match(body, /\| `ch03_security_deposits\.pdf` \|/);
  assert.ok(body.includes("03 Security Deposits 2025- Updated 8-13-25"));
  assert.ok(body.includes("03 Security Deposits 2026 - Updated 1-9-26"));
  assert.ok(body.includes(CHAPTERS_PAGE));
  assert.ok(body.includes("2026-08-24T13:00:12.000Z"));
});

test("a fully blocked run files an issue that never reads as a clean check", () => {
  const body = formatIssueBody({
    status: INCONCLUSIVE_EXIT_CODE,
    report: report({
      blocked: ["ch03_security_deposits.pdf", "handout_17_condos.pdf"],
    }),
  });

  assert.match(body, /could not be confirmed/i);
  assert.ok(body.includes("ch03_security_deposits.pdf"));
  assert.ok(body.includes("handout_17_condos.pdf"));
  // The whole point of exit 4: an unconfirmed run must not be described as
  // unchanged anywhere in the issue a human skims.
  assert.doesNotMatch(body, /nothing changed|no changes|unchanged/i);
  assert.match(body, /re-run/i);
});

test("rows with no candidate are reported apart from blocked pages", () => {
  const body = formatIssueBody({
    status: INCONCLUSIVE_EXIT_CODE,
    report: report({ notFound: ["form_repair_demand_letter.pdf"] }),
  });

  assert.match(body, /No candidate/i);
  assert.ok(body.includes("form_repair_demand_letter.pdf"));
  assert.match(body, /Blocked[^\n]*\(0\)/);
  assert.ok(body.includes("renamed"));
});

test("a run with nothing to report is refused rather than filed", () => {
  const clean = report();

  for ( const status of [0, 1, 2, 6, "3", null, undefined] ) {
    assert.throws(
      () => formatIssueBody({ status, report: clean }),
      /exit code/i,
      `status ${String(status)} should not produce an issue body`,
    );
  }
});

test("a report that is not an object is refused", () => {
  for ( const value of [null, "{}", 3, []] ) {
    assert.throws(
      () => formatIssueBody({ status: CHANGED_EXIT_CODE, report: value }),
      /report/i,
    );
  }
});

test("a revision carrying a pipe or a backtick cannot break out of the table", () => {
  const fileName = "ch04_tenancies.pdf";
  const body = formatIssueBody({
    status: CHANGED_EXIT_CODE,
    report: report({
      changed: [
        {
          fileName,
          previousRevision: "04 Tenancies 2025",
          nextRevision: "04 Tenancies | 2026 `rm -rf` v2",
        },
      ],
      entries: {
        [fileName]: {
          pdfUrl: `${FILES}/2026-01/04.pdf`,
          revision: "04 Tenancies | 2026 `rm -rf` v2",
          status: "changed",
          pageUrl: CHAPTERS_PAGE,
        },
      },
    }),
  });

  const row = body.split("\n").find((line) => line.includes(fileName));
  assert.ok(row, "the changed file must appear on a table row");
  // Three cells, so exactly four unescaped pipes: a raw pipe in the scraped
  // revision would add a fifth and shift every later column.
  const unescaped = [...row.matchAll(/(^|[^\\])\|/g)];
  assert.equal(unescaped.length, 4);
  // The backtick run inside the value must be fenced by a longer run.
  assert.ok(row.includes("`` "), "a value containing a backtick needs a longer fence");
  assert.ok(row.includes("rm -rf"));
});

test("an over-long revision is truncated instead of flooding the issue", () => {
  const long = `Handout 17 - Condos, ${"2025 ".repeat(200)}`;
  const body = formatIssueBody({
    status: CHANGED_EXIT_CODE,
    report: report({
      changed: [
        {
          fileName: "handout_17_condos.pdf",
          previousRevision: "Handout 17 - Condos, 2025",
          nextRevision: long,
        },
      ],
    }),
  });

  const row = body.split("\n").find((line) => line.includes("handout_17_condos.pdf"));
  assert.ok(row.length < 600, `row was ${row.length} characters`);
  assert.ok(row.includes("Handout 17 - Condos, 2025"));
  assert.ok(row.includes("…"));
});

test("scraped text cannot inject a newline into the issue table", () => {
  const body = formatIssueBody({
    status: CHANGED_EXIT_CODE,
    report: report({
      changed: [
        {
          fileName: "ch06_heat.pdf",
          previousRevision: "06 Heat 2025",
          nextRevision: "06 Heat 2026\n| evil | row | here |",
        },
      ],
    }),
  });

  const rows = body.split("\n").filter((line) => line.includes("evil"));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].includes("ch06_heat.pdf"));
});

test("the title states the outcome and the date the check ran", () => {
  const changed = formatIssueTitle({
    status: CHANGED_EXIT_CODE,
    report: report({ changed: [CH03_CHANGED] }),
  });
  const inconclusive = formatIssueTitle({
    status: INCONCLUSIVE_EXIT_CODE,
    report: report({ blocked: ["ch03_security_deposits.pdf"] }),
  });

  assert.match(changed, /^Corpus refresh needed: /);
  assert.ok(changed.includes("2026-08-24"));
  assert.match(inconclusive, /^Corpus check inconclusive: /);
  assert.ok(inconclusive.includes("2026-08-24"));
  assert.notEqual(changed, inconclusive);
});

test("a title never carries anything but a plain date from the report", () => {
  for ( const checkedAt of [
    "",
    null,
    "not a date",
    "2026-08-24T13:00:12.000Z`; rm -rf /",
  ] ) {
    const title = formatIssueTitle({
      status: CHANGED_EXIT_CODE,
      report: report({ checkedAt, changed: [CH03_CHANGED] }),
    });
    assert.match(title, /^[A-Za-z0-9 :()-]+$/, `title was ${title}`);
  }
  assert.ok(
    formatIssueTitle({
      status: CHANGED_EXIT_CODE,
      report: report({ checkedAt: "not a date" }),
    }).includes("unknown date"),
  );
});

test("a report missing its arrays still renders every section", () => {
  const body = formatIssueBody({
    status: INCONCLUSIVE_EXIT_CODE,
    report: { checkedAt: "2026-08-24T13:00:12.000Z" },
  });

  assert.match(body, /Changed[^\n]*\(0\)/);
  assert.match(body, /Blocked[^\n]*\(0\)/);
  assert.match(body, /No candidate[^\n]*\(0\)/);
  assert.ok(body.includes("None."));
});

test("a changed run that was also partly blocked carries both procedures", () => {
  const body = formatIssueBody({
    status: CHANGED_EXIT_CODE,
    report: report({
      changed: [CH03_CHANGED],
      blocked: ["handout_17_condos.pdf"],
      entries: {
        [CH03_CHANGED.fileName]: CH03_ENTRY,
        handout_17_condos: { status: "blocked", pageUrl: HANDOUTS_PAGE },
      },
    }),
  });

  assert.ok(body.includes("npm run corpus:refresh -- --dry-run"));
  assert.match(body, /re-run/i);
});

test("every npm command in the issue keeps the -- separator", () => {
  const body = formatIssueBody({
    status: CHANGED_EXIT_CODE,
    report: report({ changed: [CH03_CHANGED], blocked: ["handout_17_condos.pdf"] }),
  });

  // npm run corpus:refresh --dry-run forwards nothing and performs a real
  // write; the issue must never tell a maintainer to type that.
  assert.ok(!body.includes("npm run corpus:refresh --dry-run"));
  assert.ok(!body.includes("npm run corpus:check --capture"));
  assert.ok(body.includes("npm run corpus:refresh -- --dry-run"));
  assert.ok(body.includes("npm run corpus:check -- --capture=<capture file> --write-state"));
});

test("neither procedure sends a maintainer back to a crawl Cloudflare challenges", () => {
  for ( const status of [CHANGED_EXIT_CODE, INCONCLUSIVE_EXIT_CODE] ) {
    const body = formatIssueBody({
      status,
      report: report({ changed: [CH03_CHANGED], blocked: ["handout_17_condos.pdf"] }),
    });

    assert.ok(!body.includes("Re-run `Corpus Upstream Check`"), status);
    assert.ok(!body.includes("corpus_manifest.csv.bak"), status);
    for ( const command of body.match(/npm run corpus:check[^`]*/g) || [] ) {
      assert.ok(command.includes("--capture=") || command.includes("--help"), command);
    }
  }
});

test("the diagnostic re-run reads the report without rewriting recorded state", () => {
  const body = formatIssueBody({
    status: INCONCLUSIVE_EXIT_CODE,
    report: report({ blocked: ["handout_17_condos.pdf"] }),
  });

  // --write-state belongs to the changed procedure, where recording the new
  // revision is the point. Reading needs no write, and for a row still blocked
  // locally the checker records the manifest's own pdf_url -- usually empty --
  // over the live URL an earlier successful run captured.
  assert.ok(body.includes("npm run corpus:check"));
  assert.ok(!body.includes("npm run corpus:check -- --write-state"));
});

test("the ingest step names the alias corpus-ingest refuses to start without", () => {
  const body = formatIssueBody({
    status: CHANGED_EXIT_CODE,
    report: report({ changed: [CH03_CHANGED] }),
  });

  assert.ok(body.includes("knowledge_alias"));
  assert.ok(body.includes("RAG_EVAL_MILVUS_KNOWLEDGE_COLLECTION"));
});

test("the issue always states the no-evasion rule", () => {
  for ( const status of [CHANGED_EXIT_CODE, INCONCLUSIVE_EXIT_CODE] ) {
    const body = formatIssueBody({ status, report: report({ blocked: ["a.pdf"] }) });
    assert.match(body, /never/i);
    assert.match(body, /bot check/i);
  }
});

test("the workflow run is linked only when one is supplied", () => {
  const withRun = formatIssueBody({
    status: CHANGED_EXIT_CODE,
    report: report({ changed: [CH03_CHANGED] }),
    runUrl: "https://github.com/owner/leaseqa/actions/runs/42",
  });
  const withoutRun = formatIssueBody({
    status: CHANGED_EXIT_CODE,
    report: report({ changed: [CH03_CHANGED] }),
  });

  assert.ok(withRun.includes("https://github.com/owner/leaseqa/actions/runs/42"));
  assert.ok(!withoutRun.includes("actions/runs"));
});

test("parseArgs refuses an unknown flag rather than guessing", () => {
  assert.throws(() => parseArgs(["--titel"]), /Unknown argument/);
  assert.throws(() => parseArgs(["--status=0"]), /exit code/i);
  assert.throws(() => parseArgs([]), /--status/);
  assert.equal(parseArgs(["--status=4", "--title"]).title, true);
});

test("the CLI reads the report from disk and prints the body", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "leaseqa-upstream-issue-"));
  const reportPath = path.join(directory, "corpus-upstream.json");

  try {
    await writeFile(
      reportPath,
      JSON.stringify(
        report({
          changed: [CH03_CHANGED],
          entries: { [CH03_CHANGED.fileName]: CH03_ENTRY },
        }),
      ),
    );

    const body = await main([`--report=${reportPath}`, "--status=3"]);
    assert.ok(body.includes("ch03_security_deposits.pdf"));
    assert.ok(body.includes(CHAPTERS_PAGE));

    const title = await main([`--report=${reportPath}`, "--status=3", "--title"]);
    assert.equal(title.includes("\n"), false);
    assert.match(title, /^Corpus refresh needed: /);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the CLI fails loudly on a missing or unreadable report", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "leaseqa-upstream-issue-"));
  const missing = path.join(directory, "absent.json");
  const corrupt = path.join(directory, "corrupt.json");

  try {
    await writeFile(corrupt, "{ not json");
    await assert.rejects(main([`--report=${missing}`, "--status=3"]), /absent\.json/);
    await assert.rejects(main([`--report=${corrupt}`, "--status=3"]), /corrupt\.json/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


// The workflow suppresses a report that repeats the last one. It compares
// the body it is about to post, fresh from this formatter, with the previous
// report as `gh issue view --jq .body` hands it back -- and that round trip does
// not return the same bytes. The CLI writes exactly one trailing newline; the
// fetched copy ends in an extra blank line. A comparison that only trimmed
// whitespace inside lines saw that one-byte difference, called every repeat
// new, and mailed everyone watching the repository each week.
const blockedEverywhere = (checkedAt) =>
  report({
    checkedAt,
    blocked: ["ch01_moving_in.pdf", "ch03_security_deposits.pdf", "handout_17_condos.pdf"],
  });

const asPosted = (checkedAt, runId) =>
  `${formatIssueBody({
    status: INCONCLUSIVE_EXIT_CODE,
    report: blockedEverywhere(checkedAt),
    runUrl: `https://github.com/leaseqa/server/actions/runs/${runId}`,
  })}\n`;

// What `gh issue view --jq .body` returns for a comment posted from a file.
const asFetched = (posted) => `${posted}\n`;

test("isSameReport treats a fetched repeat of last week's report as the same report", () => {
  const lastWeek = asFetched(asPosted("2026-09-21T18:32:22.662Z", "35638882606"));
  const thisWeek = asPosted("2026-09-28T20:02:24.894Z", "36476203735");
  assert.equal(isSameReport(lastWeek, thisWeek), true);
});

test("isSameReport still sees a report whose findings changed", () => {
  const lastWeek = asFetched(asPosted("2026-09-21T18:32:22.662Z", "35638882606"));
  const thisWeek = `${formatIssueBody({
    status: INCONCLUSIVE_EXIT_CODE,
    report: report({ checkedAt: "2026-09-28T20:02:24.894Z", blocked: ["ch01_moving_in.pdf"] }),
    runUrl: "https://github.com/leaseqa/server/actions/runs/36476203735",
  })}\n`;
  assert.equal(isSameReport(lastWeek, thisWeek), false);
});

test("isSameReport never calls an empty previous report a duplicate", () => {
  // If fetching the previous comment fails, the workflow gets an empty file.
  // Suppressing on that would silently drop every report; post instead.
  const thisWeek = asPosted("2026-09-28T20:02:24.894Z", "36476203735");
  assert.equal(isSameReport("", thisWeek), false);
  assert.equal(isSameReport("\n\n", thisWeek), false);
});

test("isSameReport ignores line-ending and trailing-space differences", () => {
  const posted = asPosted("2026-09-28T20:02:24.894Z", "36476203735");
  const crlf = posted.replace(/\n/g, "\r\n");
  const padded = posted.split("\n").map((line) => `${line}  `).join("\n");
  assert.equal(isSameReport(crlf, posted), true);
  assert.equal(isSameReport(padded, posted), true);
});

const overdueReport = (overrides = {}) => ({
  checkedAt: "2026-12-01T13:00:04.000Z",
  lastConfirmedAt: "2026-11-09T11:45:20.852Z",
  overdueAfterDays: 40,
  ...overrides,
});

test("an overdue reminder names the last confirmed check and only a validated date reaches the title", () => {
  assert.equal(
    formatIssueTitle({ status: OVERDUE_EXIT_CODE, report: overdueReport() }),
    "Corpus check overdue: last confirmed 2026-11-09",
  );
  assert.equal(
    formatIssueTitle({ status: OVERDUE_EXIT_CODE, report: overdueReport({ lastConfirmedAt: null }) }),
    "Corpus check overdue: never confirmed",
  );
  // The title goes through a command substitution, so nothing past the date may.
  assert.equal(
    formatIssueTitle({
      status: OVERDUE_EXIT_CODE,
      report: overdueReport({ lastConfirmedAt: "2026-11-09$(rm -rf /)\n" }),
    }),
    "Corpus check overdue: last confirmed 2026-11-09",
  );
});

test("an overdue reminder asks for a capture check and for the state that records it", () => {
  const body = formatIssueBody({
    status: OVERDUE_EXIT_CODE,
    report: overdueReport(),
    runUrl: "https://github.com/leaseqa/server/actions/runs/1",
  });

  assert.ok(body.includes("2026-11-09"));
  assert.ok(body.includes("40 days"));
  assert.ok(body.includes("npm run corpus:check -- --capture=<capture file> --write-state"));
  assert.ok(body.includes("Commit `upstream_state.json`"));
  assert.ok(!body.includes("Re-run `Corpus Upstream Check`"));
  // The two lines every run changes are where the dedupe expects them.
  assert.match(body, /^- Checked at: /m);
  assert.match(body, /^- Workflow run: /m);
  assert.equal(parseArgs(["--status=5"]).status, OVERDUE_EXIT_CODE);
});
