import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

import { resolveCorpusRoot } from "../LeaseQA/RAG/config.js";
import { parseManifestCsv } from "../LeaseQA/RAG/corpusManifest.js";
import {
  GROUP_INDEX_PAGES,
  diffAgainstManifest,
  extractPdfCandidates,
  isChallengePage,
} from "../LeaseQA/RAG/upstreamCheck.js";

const HELP = `Usage: node scripts/check-corpus-upstream.js [options]

Opens the MassLegalHelp index page for each manifest source_group in a real
browser, reads the PDF links, and reports what changed upstream. It downloads
nothing: a human downloads any changed PDF, then npm run corpus:refresh
re-hashes the corpus and rewrites the manifest.

Eight page loads cover all 81 rows, because the site lists each group on one
index page. The appendix is four sub-pages; its hub carries no PDFs.

If a page returns a bot challenge it is recorded as "blocked" and left for a
human. This tool must never attempt to solve or evade that challenge. A group
whose pages load but expose no PDF links at all is also recorded as "blocked":
every hub is known to carry PDFs, so an empty one is an outage, not upstream
deleting the whole group.

Exit codes:
  0  every manifest row still has a PDF linked on its group index page whose
     decoded file name normalizes to the upstream_revision the manifest records
  3  upstream changed; the report lists what
  4  ran, but at least one row could not be confirmed -- a blocked page, or a
     manifest row with no matching PDF on a page that did load. Inconclusive,
     NOT a clean run: re-run, or look at the row by hand
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
  --corpus-root=<path>   Corpus directory (default: RAG_CORPUS_ROOT or auto-detected)
  --report=<path>        JSON report path (default: artifacts/corpus-upstream.json)
  --groups=<a,b>         Check only these source groups (default: all)
  --delay-ms=<ms>        Pause between page loads (default: 4000)
  --headed               Show the browser
  --dump-html=<path>     Save the first page's HTML for selector inspection
  --write-state          Update <corpus-root>/upstream_state.json
  --help                 Show this help`;

const KNOWN_GROUPS = Object.keys(GROUP_INDEX_PAGES);

const parseArgs = (argv) =>
  argv.reduce(
    (options, argument) => {
      if ( argument === "--help" || argument === "-h" ) {
        return { ...options, help: true };
      }
      if ( argument === "--headed" ) {
        return { ...options, headed: true };
      }
      if ( argument === "--write-state" ) {
        return { ...options, writeState: true };
      }
      if ( argument.startsWith("--corpus-root=") ) {
        return {
          ...options,
          corpusRoot: path.resolve(argument.slice("--corpus-root=".length)),
        };
      }
      if ( argument.startsWith("--report=") ) {
        return {
          ...options,
          reportPath: path.resolve(argument.slice("--report=".length)),
        };
      }
      if ( argument.startsWith("--dump-html=") ) {
        return {
          ...options,
          dumpHtml: path.resolve(argument.slice("--dump-html=".length)),
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
        return { ...options, groups };
      }
      if ( argument.startsWith("--delay-ms=") ) {
        const value = Number.parseInt(argument.slice("--delay-ms=".length), 10);
        if ( !Number.isFinite(value) || value < 0 ) {
          throw new Error(`--delay-ms needs a non-negative integer, got ${argument}`);
        }
        return { ...options, delayMs: value };
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
    },
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readPageAnchors = async (page) =>
  page.$$eval("a[href]", (nodes) =>
    nodes.map((node) => ({ href: node.href, text: node.textContent || "" })),
  );

// Read through the element handle rather than a bare `document` reference, so
// this file stays lintable under the repo's Node-only globals.
const readBodyText = async (page) => {
  try {
    return (await page.$eval("body", (node) => node.innerText || "")).slice(0, 2000);
  } catch {
    return "";
  }
};

// Returns the page's anchors, or null when the page could not be read. null
// means "we do not know what is on this page", which diffAgainstManifest turns
// into blocked rather than not_found.
const observePage = async ({ page, url, dumpHtml }) => {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    const title = await page.title();
    const bodyText = await readBodyText(page);

    if ( dumpHtml ) {
      await fs.mkdir(path.dirname(dumpHtml), { recursive: true });
      await fs.writeFile(dumpHtml, await page.content());
    }

    if ( isChallengePage(title, bodyText) ) {
      // Record and move on. No retry loop, and never an attempt to get past it.
      console.warn(`[corpus check] ${url} returned a bot challenge; recorded as blocked`);
      return null;
    }

    return await readPageAnchors(page);
  } catch ( error ) {
    // One unreadable page degrades to blocked for its group; it must not abort
    // the crawl and lose the groups already read.
    console.warn(`[corpus check] ${url} could not be read: ${error.message}`);
    return null;
  }
};

const observeGroup = async ({ page, group, urls, delayMs, dumpHtml }) => {
  const anchors = [];
  let blocked = false;

  for ( const [index, url] of urls.entries() ) {
    const pageAnchors = await observePage({
      page,
      url,
      dumpHtml: index === 0 ? dumpHtml : null,
    });
    if ( pageAnchors === null ) {
      blocked = true;
    } else {
      anchors.push(...pageAnchors);
    }
    if ( index < urls.length - 1 ) {
      await sleep(delayMs);
    }
  }

  const candidates = extractPdfCandidates(anchors);

  // Recon measured 18/19/26/19 PDFs on the four hubs, so an empty group is
  // never healthy -- it means a challenge variant outside CHALLENGE_MARKERS, a
  // redesign, a soft 404, or anchors rendered after domcontentloaded. Calling
  // that "ok" would route every row in the group to not_found and present an
  // outage as upstream having deleted the documents.
  if ( candidates.length === 0 ) {
    console.warn(
      `[corpus check] ${group}: page(s) loaded but exposed no PDF links; recorded as blocked, not as missing documents`,
    );
  }

  return {
    status: blocked || candidates.length === 0 ? "blocked" : "ok",
    // The group's primary index page. For the multi-page appendix this is the
    // first sub-page; diffAgainstManifest falls back to each row's own
    // source_url, which for appendix rows is already the exact sub-page.
    pageUrl: urls[0],
    // One extractPdfCandidates call over the merged anchor list, so a PDF
    // linked from two pages in the same group yields a single candidate.
    candidates,
  };
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
  const manifestPath = path.join(corpusRoot, "corpus_manifest.csv");
  const manifestText = await fs.readFile(manifestPath, "utf8");
  if ( manifestText.trim() === "" ) {
    throw new Error(`Manifest is empty: ${manifestPath}`);
  }

  // Checking a subset of groups must also narrow the rows, or every row in an
  // uncrawled group would be reported blocked.
  const rows = parseManifestCsv(manifestText).filter((row) =>
    options.groups.includes(row.source_group),
  );
  if ( rows.length === 0 ) {
    throw new Error(`No manifest rows for group(s): ${options.groups.join(", ")}`);
  }

  const browser = await chromium.launch({ headless: !options.headed });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();

  const observations = {};
  let dumpHtml = options.dumpHtml;

  try {
    for ( const [index, group] of options.groups.entries() ) {
      const urls = GROUP_INDEX_PAGES[group];
      observations[group] = await observeGroup({
        page,
        group,
        urls,
        delayMs: options.delayMs,
        dumpHtml,
      });
      dumpHtml = null;

      console.info(
        `[corpus check] ${group}: ${observations[group].status}, ${observations[group].candidates.length} PDFs across ${urls.length} page(s)`,
      );

      if ( index < options.groups.length - 1 ) {
        await sleep(options.delayMs);
      }
    }
  } finally {
    await browser.close();
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
    console.warn(`BLOCKED (inconclusive, re-run later): ${diff.blocked.join(", ")}`);
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
