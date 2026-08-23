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
const HELP = `Usage: node scripts/format-upstream-issue.js --status=<3|4> [options]

Reads the report written by scripts/check-corpus-upstream.js and writes the
GitHub issue body to stdout. Reads and formats only: it opens no issue, makes no
network call, and never touches the upstream site.

Only exit codes 3 and 4 file an issue. 0 means every row was confirmed against
the live site and 1 means the checker itself broke, so both are refused here.

Options:
  --status=<3|4>      The checker's exit code: 3 changed, 4 inconclusive (required)
  --report=<path>     JSON report path (default: artifacts/corpus-upstream.json)
  --run-url=<url>     Workflow run to link from the issue
  --title             Print the issue title instead of the body
  --help              Show this help`;

export const CHANGED_EXIT_CODE = 3;
export const INCONCLUSIVE_EXIT_CODE = 4;

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
  if ( status !== CHANGED_EXIT_CODE && status !== INCONCLUSIVE_EXIT_CODE ) {
    throw new Error(
      `Refusing to build an issue for exit code ${JSON.stringify(status)}: only ${CHANGED_EXIT_CODE} (upstream changed) and ${INCONCLUSIVE_EXIT_CODE} (inconclusive) file one.`,
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
const checkedOn = (report) => {
  const match = ISO_DATE_PATTERN.exec(collapse(report?.checkedAt));
  return match ? match[1] : "unknown date";
};

export const formatIssueTitle = ({ status, report }) => {
  assertStatusFilesAnIssue(status);
  assertReadableReport(report);

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
  "2. `npm run corpus:check -- --write-state` from the repository root, to record the new revision and upload URL in `upstream_state.json`.",
  "3. `npm run corpus:refresh -- --dry-run` to preview, then `npm run corpus:refresh` to write. The `--` separator is required: without it npm forwards nothing to the script and the preview performs a real write.",
  "4. Commit the changed PDFs, `corpus_manifest.csv`, `corpus_manifest.csv.bak` and `upstream_state.json` together.",
  "5. Run the `corpus-ingest` workflow (`workflow_dispatch`; `min_hit_rate` defaults to `0.9`). The retrieval gate decides whether the alias moves.",
  "",
];

const unconfirmedProcedure = () => [
  "For the rows this run could not confirm:",
  "",
  "1. Re-run `Corpus Upstream Check` from the Actions tab. A blocked page is usually transient, and a second run at another hour normally clears it.",
  "2. If it stays blocked, run `npm run corpus:check -- --write-state` locally and read the report. A desktop connection is not challenged the way a datacenter one is.",
  "3. For a row with no candidate, open its group index page by hand: upstream may have renamed the PDF beyond what the matcher can join, or withdrawn it.",
  "",
];

export const formatIssueBody = ({ status, report, runUrl = "" }) => {
  assertStatusFilesAnIssue(status);
  assertReadableReport(report);

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
    `**Never** add a retry loop, a user-agent change, or anything else that defeats, solves, or evades the upstream bot check. A blocked page is reported and left to a human ${EM_DASH} that rule is why this check reports rather than downloads.`,
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
        if ( status !== CHANGED_EXIT_CODE && status !== INCONCLUSIVE_EXIT_CODE ) {
          throw new Error(
            `--status must be the checker's exit code ${CHANGED_EXIT_CODE} (changed) or ${INCONCLUSIVE_EXIT_CODE} (inconclusive), got ${JSON.stringify(raw)}. Exit code 0 confirms every row, so it files nothing.`,
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
      `--status is required: pass the checker's exit code, ${CHANGED_EXIT_CODE} or ${INCONCLUSIVE_EXIT_CODE}.`,
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
