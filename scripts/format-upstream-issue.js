import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Turns the JSON report from scripts/check-corpus-upstream.js into the body of
// the GitHub issue that .github/workflows/corpus-upstream-check.yml files.
//
// It lives in a file, and not in a node -e inside the workflow YAML, because
// every string it formats was scraped from a third-party site: revisions really
// do contain commas, and a heredoc inside YAML inside $(...) is three layers of
// quoting over data we do not control. The workflow redirects this to a file and
// passes --body-file, so no scraped byte is ever interpolated into a shell word.
const HELP = `Usage: node scripts/format-upstream-issue.js --status=<3|4|5> [options]

Reads the report written by scripts/check-corpus-upstream.js and writes the
GitHub issue body to stdout. Reads and formats only: it opens no issue, makes no
network call, and never touches the upstream site.

Only exit codes 3, 4 and 5 file an issue: 5 is the reminder that no capture
check has confirmed the corpus recently. 0 means the check was clean, or not
yet due, and 1 means the checker itself broke, so both are refused here.

Options:
  --status=<3|4|5>    The checker's exit code: 3 changed, 4 inconclusive, 5 overdue (required)
  --report=<path>     JSON report path (default: artifacts/corpus-upstream.json)
  --run-url=<url>     Workflow run to link from the issue
  --title             Print the issue title instead of the body
  --help              Show this help`;

export const CHANGED_EXIT_CODE = 3;
export const INCONCLUSIVE_EXIT_CODE = 4;
export const OVERDUE_EXIT_CODE = 5;

const ISSUE_STATUSES = [CHANGED_EXIT_CODE, INCONCLUSIVE_EXIT_CODE, OVERDUE_EXIT_CODE];

export const UPSTREAM_ISSUE_LABEL = "corpus-upstream";

const CORPUS_PDF_DIRECTORY = "resources/rag-corpus/mass tenant rights/pdf";

// A single cell is capped so that one absurd scraped string cannot push the
// body past GitHub's issue length limit and take the whole report with it.
const MAX_CELL_LENGTH = 200;

// upstreamCheck.js already collapses these at the point of scraping, but this
// module reads a file off disk and must hold on its own: a newline inside a
// revision would otherwise split one table row into two and let scraped text
// pose as its own row. \p{Cc} covers NUL through US and DEL, which are not
// whitespace; \p{Cf} covers the invisible bidi overrides, which reorder what a
// maintainer reads without changing what is stored.
const CONTROL_OR_SPACE_PATTERN = /[\s\p{Cc}\p{Cf}]+/gu;

const collapse = (value) =>
  String(value ?? "")
    .replace(CONTROL_OR_SPACE_PATTERN, " ")
    .trim();

const truncate = (value) =>
  value.length <= MAX_CELL_LENGTH ? value : `${value.slice(0, MAX_CELL_LENGTH - 1)}…`;

// CommonMark ends a code span at the first backtick run of the same length, so
// a scraped value containing backticks needs a longer fence and a space pad --
// otherwise the value escapes the code span and the rest of the row is parsed
// as markdown.
const inlineCode = (raw) => {
  const value = truncate(collapse(raw));
  if ( value === "" ) {
    return "";
  }
  const longestRun = Math.max(
    0,
    ...[...value.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestRun + 1);
  const pad = longestRun > 0 ? " " : "";
  return `${fence}${pad}${value}${pad}${fence}`;
};

const EM_DASH = "—";

// GFM splits table cells on every unescaped pipe, including inside a code span,
// so escaping has to happen after the fence is built.
const cell = (raw) => {
  const code = inlineCode(raw);
  return ( code === "" ? EM_DASH : code ).replaceAll("|", "\\|");
};

const bullet = (raw) => `- ${inlineCode(raw)}`;

const plural = (count, singular, many) => `${count} ${count === 1 ? singular : many}`;

const asArray = (value) => ( Array.isArray(value) ? value : [] );

const assertStatusFilesAnIssue = (status) => {
  if ( !ISSUE_STATUSES.includes(status) ) {
    throw new Error(
      `Refusing to build an issue for exit code ${JSON.stringify(status)}: only ${CHANGED_EXIT_CODE} (upstream changed), ${INCONCLUSIVE_EXIT_CODE} (inconclusive) and ${OVERDUE_EXIT_CODE} (overdue) file one.`,
    );
  }
};

const assertReadableReport = (report) => {
  if ( !report || typeof report !== "object" || Array.isArray(report) ) {
    throw new Error(
      `The report must be the JSON object written by scripts/check-corpus-upstream.js, got ${JSON.stringify(report)}`,
    );
  }
};

const ISO_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})/;

// The title is the one string that cannot be handed to gh through a file, so it
// carries no scraped text at all -- only a date this pattern accepted.
const isoDate = (value) => ISO_DATE_PATTERN.exec(collapse(value))?.[1] ?? null;

const checkedOn = (report) => isoDate(report?.checkedAt) ?? "unknown date";

export const formatIssueTitle = ({ status, report }) => {
  assertStatusFilesAnIssue(status);
  assertReadableReport(report);

  if ( status === OVERDUE_EXIT_CODE ) {
    const confirmed = isoDate(report.lastConfirmedAt);
    return `Corpus check overdue: ${confirmed ? `last confirmed ${confirmed}` : "never confirmed"}`;
  }

  const suffix = `(checked ${checkedOn(report)})`;
  return status === CHANGED_EXIT_CODE
    ? `Corpus refresh needed: MassLegalHelp published changes ${suffix}`
    : `Corpus check inconclusive: upstream could not be confirmed ${suffix}`;
};

const changedSection = (changed, entries) => {
  const lines = [`### Changed (${changed.length})`, ""];

  if ( changed.length === 0 ) {
    return [...lines, "None.", ""];
  }

  lines.push(
    "| File | Recorded revision | Upstream revision |",
    "| --- | --- | --- |",
    ...changed.map(
      (entry) =>
        `| ${cell(entry?.fileName)} | ${cell(entry?.previousRevision)} | ${cell(entry?.nextRevision)} |`,
    ),
    "",
  );

  const pages = [
    ...new Set(
      changed
        .map((entry) => collapse(entries?.[entry?.fileName]?.pageUrl))
        .filter(Boolean),
    ),
  ];

  if ( pages.length > 0 ) {
    lines.push(
      "Download each changed PDF from its group page, in a real browser:",
      "",
      ...pages.map(bullet),
      "",
    );
  }

  return lines;
};

const listSection = ({ heading, explanation, names }) => {
  const lines = [`### ${heading} (${names.length})`, "", explanation, ""];
  return names.length === 0
    ? [...lines, "None.", ""]
    : [...lines, ...names.map(bullet), ""];
};

const changedProcedure = () => [
  "For the changed files:",
  "",
  `1. Open each download page above in a real browser and save the new PDF over the existing one under \`${CORPUS_PDF_DIRECTORY}/<group>/\`, keeping its current file name.`,
  "2. Capture the eight index pages again in your browser (the page list and the console snippet are in `npm run corpus:check -- --help`), then run `npm run corpus:check -- --capture=<capture file> --write-state` from the repository root, to record the new revision and upload URL in `upstream_state.json`.",
  "3. `npm run corpus:refresh -- --dry-run` to preview, then `npm run corpus:refresh` to write. The `--` separator is required: without it npm forwards nothing to the script and the preview performs a real write.",
  "4. Commit the changed PDFs, `corpus_manifest.csv` and `upstream_state.json` together.",
  "5. Run the `corpus-ingest` workflow (`workflow_dispatch`; `min_hit_rate` defaults to `0.9`). Supply the `knowledge_alias` input, or have the `RAG_EVAL_MILVUS_KNOWLEDGE_COLLECTION` secret set: the workflow refuses to start without an explicit target alias. The retrieval gate then decides whether that alias moves.",
  "",
];

const unconfirmedProcedure = () => [
  "For the rows this run could not confirm:",
  "",
  "1. Capture the eight index pages in an ordinary browser and run `npm run corpus:check -- --capture=<capture file>` (the page list and the console snippet are in `npm run corpus:check -- --help`). Re-running this workflow or crawling locally will not clear a block: a crawl cannot get past the bot check, and `--help` says why. Leave `--write-state` off until every row is confirmed: for a row that is still blocked the checker records the manifest's own `pdf_url` -- usually empty -- over the live URL an earlier run captured.",
  "2. For a row with no candidate, open its group index page by hand: upstream may have renamed the PDF beyond what the matcher can join, or withdrawn it.",
  "",
];

// Two reports are the same report when they differ only in what every run
// changes on its own: when it ran, which run it was, and whitespace. The
// workflow uses this to avoid re-posting an identical inconclusive report on
// every run while a page stays blocked.
//
// Whitespace has to be forgiving, and not only inside lines. The previous report
// arrives through `gh issue view --jq .body`, which hands back one more trailing
// newline than the file this formatter writes, so blank lines are dropped before
// comparing rather than trimmed.
const VOLATILE_LINE = /^- (Checked at|Workflow run):/;

export const normaliseReport = (text) =>
  String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !VOLATILE_LINE.test(line))
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .join("\n");

// An empty previous report is never a duplicate: that is what a failed fetch
// looks like, and suppressing on it would silently drop every report after.
export const isSameReport = (previous, next) => {
  const before = normaliseReport(previous);
  return before !== "" && before === normaliseReport(next);
};

const NEVER_EVADE = `**Never** add a retry loop, a user-agent change, or anything else that defeats, solves, or evades the upstream bot check. A blocked page is reported and left to a human ${EM_DASH} that rule is why this check reports rather than downloads.`;

const overdueBody = ({ report, runUrl }) => {
  const confirmed = isoDate(report.lastConfirmedAt);
  const limit = Number.isInteger(report.overdueAfterDays) ? `, and the limit is ${report.overdueAfterDays} days` : "";
  const facts = [
    `- Checked at: ${inlineCode(report.checkedAt) || EM_DASH}`,
    `- Last confirmed: ${confirmed ? inlineCode(confirmed) : "never"}, from the committed \`upstream_state.json\`.`,
  ];
  if ( collapse(runUrl) !== "" ) {
    facts.splice(1, 0, `- Workflow run: ${inlineCode(runUrl)}`);
  }

  return [
    "## Corpus check overdue",
    "",
    `No capture check has confirmed the corpus ${confirmed ? `since ${confirmed}` : "yet"}${limit}. A crawl cannot get past MassLegalHelp's bot check (see \`npm run corpus:check -- --help\`), so the check runs on pages read in a browser.`,
    "",
    ...facts,
    "",
    "### Next steps",
    "",
    "1. Capture the eight index pages in an ordinary browser and run `npm run corpus:check -- --capture=<capture file> --write-state` (the page list and the console snippet are in `npm run corpus:check -- --help`).",
    "2. Commit `upstream_state.json`. This reminder reads the committed copy, so a check that is not committed does not count.",
    "3. If the check reports changed files, follow the refresh procedure in `resources/rag-corpus/mass tenant rights/CORPUS_GUIDE.md`.",
    "",
    "---",
    "",
    NEVER_EVADE,
  ];
};

export const formatIssueBody = ({ status, report, runUrl = "" }) => {
  assertStatusFilesAnIssue(status);
  assertReadableReport(report);

  if ( status === OVERDUE_EXIT_CODE ) {
    return `${overdueBody({ report, runUrl }).join("\n")}\n`;
  }

  const changed = asArray(report.changed);
  const blocked = asArray(report.blocked).map(collapse).filter(Boolean);
  const notFound = asArray(report.notFound).map(collapse).filter(Boolean);
  const unconfirmed = blocked.length + notFound.length;

  const headline =
    status === CHANGED_EXIT_CODE
      ? "## Corpus drift: MassLegalHelp published changes"
      : "## Corpus check inconclusive: the corpus could not be confirmed";

  const lead =
    status === CHANGED_EXIT_CODE
      ? `\`scripts/check-corpus-upstream.js\` exited ${CHANGED_EXIT_CODE}: ${plural(changed.length, "file carries", "files carry")} a revision that \`corpus_manifest.csv\` does not record. The checker downloads nothing, so a human retrieves each PDF in a real browser before the refresh and ingest tools run.`
      : `\`scripts/check-corpus-upstream.js\` exited ${INCONCLUSIVE_EXIT_CODE}: it ran, but ${plural(unconfirmed, "row", "rows")} could not be confirmed against the live site. The run therefore proves nothing in either direction — treat the corpus state as unknown. Exit ${INCONCLUSIVE_EXIT_CODE} exists precisely so a run that observed nothing can never be filed as a clean one.`;

  const facts = [
    `- Checked at: ${inlineCode(report.checkedAt) || EM_DASH}`,
    `- Changed: ${changed.length}. Blocked: ${blocked.length}. No candidate: ${notFound.length}.`,
    "- Full report: the `corpus-upstream-<run id>` artifact on the workflow run.",
  ];
  if ( collapse(runUrl) !== "" ) {
    facts.splice(2, 0, `- Workflow run: ${inlineCode(runUrl)}`);
  }

  const lines = [
    headline,
    "",
    lead,
    "",
    ...facts,
    "",
    ...changedSection(changed, report.entries),
    ...listSection({
      heading: `Blocked ${EM_DASH} the page could not be read`,
      explanation:
        "A bot challenge, a network error, or a group page that loaded but exposed no PDF links at all. Nothing is known about these rows.",
      names: blocked,
    }),
    ...listSection({
      heading: `No candidate ${EM_DASH} the page loaded, no PDF matched the row`,
      explanation:
        "Either upstream renamed the PDF beyond what the matcher can join, or it withdrew the document. Both need a human to look at the page.",
      names: notFound,
    }),
    "### Next steps",
    "",
  ];

  if ( changed.length > 0 ) {
    lines.push(...changedProcedure());
  }
  if ( unconfirmed > 0 ) {
    lines.push(...unconfirmedProcedure());
  }
  if ( changed.length === 0 && unconfirmed === 0 ) {
    lines.push(
      "The checker reported this run as inconclusive but listed no rows. Read the report artifact and the run log before trusting either outcome.",
      "",
    );
  }

  lines.push(
    "---",
    "",
    NEVER_EVADE,
  );

  return `${lines.join("\n")}\n`;
};

export const parseArgs = (argv) => {
  const options = argv.reduce(
    (current, argument) => {
      if ( argument === "--help" || argument === "-h" ) {
        return { ...current, help: true };
      }
      if ( argument === "--title" ) {
        return { ...current, title: true };
      }
      if ( argument.startsWith("--report=") ) {
        return {
          ...current,
          reportPath: path.resolve(argument.slice("--report=".length)),
        };
      }
      if ( argument.startsWith("--run-url=") ) {
        return { ...current, runUrl: argument.slice("--run-url=".length) };
      }
      if ( argument.startsWith("--status=") ) {
        const raw = argument.slice("--status=".length);
        const status = Number.parseInt(raw, 10);
        if ( !ISSUE_STATUSES.includes(status) ) {
          throw new Error(
            `--status must be the checker's exit code ${CHANGED_EXIT_CODE} (changed), ${INCONCLUSIVE_EXIT_CODE} (inconclusive) or ${OVERDUE_EXIT_CODE} (overdue), got ${JSON.stringify(raw)}. Exit code 0 files nothing.`,
          );
        }
        return { ...current, status };
      }
      // A typo like --titel must not silently print the body where the caller
      // asked for a title; gh would then use a whole markdown document as the
      // issue title.
      throw new Error(`Unknown argument: ${argument}`);
    },
    {
      help: false,
      title: false,
      status: null,
      runUrl: "",
      reportPath: path.resolve("artifacts", "corpus-upstream.json"),
    },
  );

  if ( !options.help && options.status === null ) {
    throw new Error(
      `--status is required: pass the checker's exit code, ${ISSUE_STATUSES.join(", ")}.`,
    );
  }

  return options;
};

const readReport = async (reportPath) => {
  try {
    return JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch ( error ) {
    // Without the path in the message, a workflow failure here reads as "the
    // formatter broke" rather than "the checker wrote no report".
    throw new Error(`Could not read the upstream report ${reportPath}: ${error.message}`);
  }
};

export const main = async (argv) => {
  const options = parseArgs(argv);
  if ( options.help ) {
    return HELP;
  }

  const report = await readReport(options.reportPath);

  return options.title
    ? formatIssueTitle({ status: options.status, report })
    : formatIssueBody({
        status: options.status,
        report,
        runUrl: options.runUrl,
      });
};

const isExecutedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if ( isExecutedDirectly ) {
  main(process.argv.slice(2))
    .then((text) => {
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    })
    .catch((error) => {
      console.error(`Formatting the upstream issue failed: ${error.message}`);
      process.exitCode = 1;
    });
}
