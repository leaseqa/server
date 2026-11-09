import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { resolveCorpusRoot } from "../LeaseQA/RAG/config.js";
import { parseManifestCsv } from "../LeaseQA/RAG/corpusManifest.js";
import {
  CAPTURE_SNIPPET,
  CHALLENGE_TEXT_LENGTH,
  GROUP_INDEX_PAGES,
  diffAgainstManifest,
  isCheckOverdue,
  lastConfirmedCheckAt,
  observationsFromPages,
  parseCapture,
} from "../LeaseQA/RAG/upstreamCheck.js";

const OVERDUE_EXIT_CODE = 5;

const HELP = `Usage: node scripts/check-corpus-upstream.js [options]

Reads the PDF links on the MassLegalHelp index page for each manifest
source_group and reports what changed upstream. It downloads nothing: a human
downloads any changed PDF, then npm run corpus:refresh re-hashes the corpus and
rewrites the manifest.

Eight pages cover all 81 rows, because the site lists each group on one index
page. The appendix is four sub-pages; its hub carries no PDFs:
${Object.values(GROUP_INDEX_PAGES).flat().map((url) => `  ${url}`).join("\n")}

Why it reads pages you captured: MassLegalHelp sits behind Cloudflare, which
challenges automated browsers. A headless crawl has met a challenge on every
page since 2026-08. A headed Chrome, tried on 2026-11-09, read the first page and
met one on every page after it, on a GitHub runner and on a home connection
alike. This tool must never attempt to solve or evade that challenge, so no crawl
setting fixes it, while an ordinary browser session loads all eight pages.

So run it with --capture. Open the eight pages in your browser, run this in each
page's devtools console, and paste each result as one line of the capture file:

  ${CAPTURE_SNIPPET}

Without --capture it crawls in Playwright's Chromium, as the
corpus-upstream-check workflow does when dispatched, which is how to see whether
a crawl gets through again. In either mode a page showing a bot challenge counts
as not read, and its group is "blocked", as is a group whose pages expose no PDF
links at all: every hub is known to carry PDFs, so an empty one is an outage,
not upstream deleting the whole group. The log names each page that was not
read, so you know which to capture again.

--overdue-after-days=<n> reads nothing upstream. It asks upstream_state.json
when a run last read every group and confirmed every row, and exits 5 if that
was more than n days ago or never. The workflow runs it on the 1st of each
month, so commit upstream_state.json after each check.

Exit codes:
  0  every manifest row still has a PDF linked on its group index page whose
     decoded file name normalizes to the upstream_revision the manifest records;
     with --overdue-after-days, a recent enough check confirmed that
  3  upstream changed; the report lists what
  4  ran, but at least one row could not be confirmed -- a page not read, or a
     manifest row with no matching PDF on a page that did load. Inconclusive,
     NOT a clean run: capture the pages the log names and use --capture, or
     look at the row by hand
  5  --overdue-after-days only: no check has confirmed the corpus within that
     many days
  1  the tool itself failed

0 is never "we saw nothing": a run that could not confirm a row exits 4. But it
is narrower than "the corpus is current". Only revision strings are compared,
so two real kinds of drift pass as 0, both by design and neither a bug:

  * A same-name re-upload. If MassLegalHelp corrects a document and re-uploads
    it under the same file name, the revision string is unchanged and this
    exits 0. The upload-month directory inside the PDF URL does move, but
    nothing compares it, and only re-downloading and re-hashing the bytes would
    prove the text changed.
  * A newly published document. Candidates matching no manifest row are ignored
    on purpose, so a new chapter, handout or form is never reported here.

Catching either needs a human reading the index pages. Neither is something a
0 from this tool rules out.

Options:
  --corpus-root=<path>      Corpus directory (default: RAG_CORPUS_ROOT or auto-detected)
  --report=<path>           JSON report path (default: artifacts/corpus-upstream.json)
  --groups=<a,b>            Check only these source groups (default: all)
  --capture=<path>          Read pages captured in a browser instead of crawling:
                            one JSON object per line, as the snippet above copies it
  --write-state             Update <corpus-root>/upstream_state.json
  --overdue-after-days=<n>  Only report whether a check is due (see above)
  --delay-ms=<ms>           Crawl only: pause between page loads (default: 4000)
  --headed                  Crawl only: show the browser
  --dump-html=<path>        Crawl only: save the first page's HTML for selector inspection
  --help                    Show this help`;

const KNOWN_GROUPS = Object.keys(GROUP_INDEX_PAGES);

const parsePositiveInteger = (argument, flag) => {
  const raw = argument.slice(flag.length + 1);
  const value = Number.parseInt(raw, 10);
  if ( !/^\d+$/.test(raw) || value < 1 ) {
    throw new Error(`${flag} needs a positive whole number of days, got ${argument}`);
  }
  return value;
};

const parseArgs = (argv) => {
  const options = argv.reduce(
    (current, argument) => {
      if ( argument === "--help" || argument === "-h" ) {
        return { ...current, help: true };
      }
      if ( argument === "--headed" ) {
        return { ...current, headed: true };
      }
      if ( argument === "--write-state" ) {
        return { ...current, writeState: true };
      }
      if ( argument.startsWith("--corpus-root=") ) {
        return {
          ...current,
          corpusRoot: path.resolve(argument.slice("--corpus-root=".length)),
        };
      }
      if ( argument.startsWith("--report=") ) {
        return {
          ...current,
          reportPath: path.resolve(argument.slice("--report=".length)),
        };
      }
      if ( argument.startsWith("--dump-html=") ) {
        return {
          ...current,
          dumpHtml: path.resolve(argument.slice("--dump-html=".length)),
        };
      }
      if ( argument.startsWith("--capture=") ) {
        return {
          ...current,
          capturePath: path.resolve(argument.slice("--capture=".length)),
        };
      }
      if ( argument.startsWith("--overdue-after-days=") ) {
        return {
          ...current,
          overdueAfterDays: parsePositiveInteger(argument, "--overdue-after-days"),
        };
      }
      if ( argument.startsWith("--groups=") ) {
        const groups = argument
          .slice("--groups=".length)
          .split(",")
          .map((group) => group.trim())
          .filter(Boolean);
        const unknown = groups.filter((group) => !KNOWN_GROUPS.includes(group));
        if ( groups.length === 0 || unknown.length > 0 ) {
          throw new Error(
            `Unknown source group(s): ${unknown.join(", ") || "(none given)"}. Known: ${KNOWN_GROUPS.join(", ")}`,
          );
        }
        return { ...current, groups };
      }
      if ( argument.startsWith("--delay-ms=") ) {
        const value = Number.parseInt(argument.slice("--delay-ms=".length), 10);
        if ( !Number.isFinite(value) || value < 0 ) {
          throw new Error(`--delay-ms needs a non-negative integer, got ${argument}`);
        }
        return { ...current, delayMs: value };
      }
      // Silently ignoring a typo like --write-stat would make the operator
      // believe state was written when it was not.
      throw new Error(`Unknown argument: ${argument}`);
    },
    {
      help: false,
      headed: false,
      writeState: false,
      corpusRoot: null,
      reportPath: path.resolve("artifacts", "corpus-upstream.json"),
      dumpHtml: null,
      groups: KNOWN_GROUPS,
      delayMs: 4000,
      capturePath: null,
      overdueAfterDays: null,
    },
  );

  // The due check only reads the committed state. Accepting a capture or a state
  // write alongside it would let an operator believe the pages were checked.
  if ( options.overdueAfterDays !== null && (options.capturePath || options.writeState) ) {
    throw new Error("--overdue-after-days reads upstream_state.json only; it does not combine with --capture or --write-state");
  }
  return options;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readPageAnchors = async (page) =>
  page.$$eval("a[href]", (nodes) =>
    nodes.map((node) => ({ href: node.href, text: node.textContent || "" })),
  );

// Read through the element handle rather than a bare `document` reference, so
// this file stays lintable under the repo's Node-only globals.
const readBodyText = async (page) => {
  try {
    return (await page.$eval("body", (node) => node.innerText || "")).slice(0, CHALLENGE_TEXT_LENGTH);
  } catch {
    return "";
  }
};

// One page record, the shape the capture snippet writes, or null when the page
// could not be loaded at all. Whether it shows a challenge is decided along with
// captured records, in observationsFromPages; nothing here retries a page or
// tries to get past a challenge.
const crawlPage = async ({ page, url, dumpHtml }) => {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    if ( dumpHtml ) {
      await fs.mkdir(path.dirname(dumpHtml), { recursive: true });
      await fs.writeFile(dumpHtml, await page.content());
    }

    return {
      url,
      title: await page.title(),
      bodyText: await readBodyText(page),
      anchors: await readPageAnchors(page),
    };
  } catch ( error ) {
    // One page that will not load degrades to blocked for its group; it must not
    // abort the crawl and lose the pages already read.
    console.warn(`[corpus check] ${url} could not be loaded: ${error.message}`);
    return null;
  }
};

const crawl = async ({ groups, headed, delayMs, dumpHtml }) => {
  const urls = groups.flatMap((group) => GROUP_INDEX_PAGES[group]);
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();
  const records = [];

  try {
    for ( const [index, url] of urls.entries() ) {
      const record = await crawlPage({ page, url, dumpHtml: index === 0 ? dumpHtml : null });
      if ( record ) {
        records.push(record);
      }
      if ( index < urls.length - 1 ) {
        await sleep(delayMs);
      }
    }
  } finally {
    await browser.close();
  }
  return records;
};

const readCapture = async (filePath) => {
  try {
    return parseCapture(await fs.readFile(filePath, "utf8"));
  } catch ( error ) {
    throw new Error(`${filePath}: ${error.message}`);
  }
};

const UNREAD_REASONS = {
  missing: { capture: "is not in the capture", crawl: "was not loaded" },
  challenge: { capture: "showed a bot challenge", crawl: "showed a bot challenge" },
  "no link list": { capture: "has no link list in its record", crawl: "has no link list" },
};

const reportPages = ({ unread, unmatched, mode }) => {
  for ( const { url, reason } of unread ) {
    console.warn(`[corpus check] ${url} ${UNREAD_REASONS[reason][mode]}; its group is blocked`);
  }
  for ( const url of unmatched ) {
    console.warn(
      `[corpus check] a record for ${url || "(no url)"} matches none of the eight index pages and was ignored`,
    );
  }
};

const reportGroup = (group, observation) => {
  if ( observation.candidates.length === 0 ) {
    console.warn(
      `[corpus check] ${group}: no PDF links read; recorded as blocked, not as missing documents`,
    );
  }
  console.info(
    `[corpus check] ${group}: ${observation.status}, ${observation.candidates.length} PDFs across ${GROUP_INDEX_PAGES[group].length} page(s)`,
  );
};

const readJsonIfPresent = async (filePath) => {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch ( error ) {
    if ( error?.code === "ENOENT" ) {
      return null;
    }
    // A corrupt state file must not be silently flattened: the operator would
    // lose recorded upstream values without ever being told.
    throw new Error(`Could not read ${filePath}: ${error.message}`);
  }
};

// upstream_state.json feeds straight into planManifestRefresh. A half-written
// file would make JSON.parse throw there and block the refresh entirely, so
// write to a temp file and rename it into place.
const writeJsonSafely = async ({ filePath, value }) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(tempPath, filePath);
  } catch ( error ) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
};

const checkOverdue = async ({ corpusRoot, reportPath, overdueAfterDays }) => {
  const now = new Date();
  const lastConfirmedAt = lastConfirmedCheckAt(
    await readJsonIfPresent(path.join(corpusRoot, "upstream_state.json")),
  );
  const overdue = isCheckOverdue({ lastConfirmedAt, now, maxAgeDays: overdueAfterDays });

  await writeJsonSafely({
    filePath: reportPath,
    value: { checkedAt: now.toISOString(), lastConfirmedAt, overdueAfterDays },
  });
  console.log(
    `SUMMARY lastConfirmed=${lastConfirmedAt ?? "never"} overdueAfterDays=${overdueAfterDays} overdue=${overdue} report=${reportPath}`,
  );
  return overdue ? OVERDUE_EXIT_CODE : 0;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if ( options.help ) {
    console.log(HELP);
    return 0;
  }

  const corpusRoot = options.corpusRoot || resolveCorpusRoot();
  // resolveCorpusRoot() walks up to parent directories when the checkout has no
  // corpus, and --write-state writes upstream_state.json into whichever root
  // won. CORPUS_GUIDE.md tells the operator to stop if this is not the checkout.
  console.log(`[corpus check] corpusRoot: ${corpusRoot}`);

  if ( options.overdueAfterDays !== null ) {
    return checkOverdue({ ...options, corpusRoot });
  }

  const manifestPath = path.join(corpusRoot, "corpus_manifest.csv");
  const manifestText = await fs.readFile(manifestPath, "utf8");
  if ( manifestText.trim() === "" ) {
    throw new Error(`Manifest is empty: ${manifestPath}`);
  }

  // Checking a subset of groups must also narrow the rows, or every row in an
  // unchecked group would be reported blocked.
  const rows = parseManifestCsv(manifestText).filter((row) =>
    options.groups.includes(row.source_group),
  );
  if ( rows.length === 0 ) {
    throw new Error(`No manifest rows for group(s): ${options.groups.join(", ")}`);
  }

  const mode = options.capturePath ? "capture" : "crawl";
  const records =
    mode === "capture" ? await readCapture(options.capturePath) : await crawl(options);
  const { observations, unread, unmatched } = observationsFromPages({
    pages: records,
    groups: options.groups,
  });
  reportPages({ unread, unmatched, mode });
  for ( const group of options.groups ) {
    reportGroup(group, observations[group]);
  }

  const diff = diffAgainstManifest({ rows, observations, now: new Date() });

  await writeJsonSafely({ filePath: options.reportPath, value: diff });

  if ( options.writeState ) {
    const statePath = path.join(corpusRoot, "upstream_state.json");
    // A --groups run only has entries for the groups it checked. Writing those
    // alone would drop every other row's recorded pdfUrl and revision, losing
    // upload-month URLs captured by an earlier full run, so merge over what is
    // already there rather than replacing the file.
    const previous = await readJsonIfPresent(statePath);
    await writeJsonSafely({
      filePath: statePath,
      value: {
        checkedAt: diff.checkedAt,
        checkedGroups: options.groups,
        note: "Written by scripts/check-corpus-upstream.js. Never referenced by corpus_manifest.csv, so it is not part of corpusVersion. Entries outside checkedGroups are carried over from an earlier run and are older than checkedAt.",
        entries: { ...(previous?.entries || {}), ...diff.entries },
      },
    });
  }

  for ( const entry of diff.changed ) {
    console.log(
      `CHANGED ${entry.fileName}: ${entry.previousRevision} -> ${entry.nextRevision}`,
    );
  }
  if ( diff.blocked.length > 0 ) {
    console.warn(
      `BLOCKED (inconclusive; capture the pages named above and use --capture): ${diff.blocked.join(", ")}`,
    );
  }
  if ( diff.notFound.length > 0 ) {
    console.warn(`NOT FOUND (needs a human): ${diff.notFound.join(", ")}`);
  }

  const unconfirmed = diff.blocked.length + diff.notFound.length;
  console.log(
    `SUMMARY checked=${rows.length} changed=${diff.changed.length} blocked=${diff.blocked.length} notFound=${diff.notFound.length} report=${options.reportPath}`,
  );

  if ( diff.changed.length > 0 ) {
    return 3;
  }
  // Never report a clean 0 for a run that could not confirm every row: a
  // monitoring tool that exits 0 after observing nothing is worse than one
  // that fails loudly.
  if ( unconfirmed > 0 ) {
    console.warn(
      `INCONCLUSIVE: ${unconfirmed} of ${rows.length} rows unconfirmed; exiting 4, not 0`,
    );
    return 4;
  }
  return 0;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("Corpus upstream check failed:", error);
    process.exitCode = 1;
  });
