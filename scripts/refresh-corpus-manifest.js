import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveCorpusRoot } from "../LeaseQA/RAG/config.js";
import {
  parseManifestCsv,
  planManifestRefresh,
  serializeManifestCsv,
} from "../LeaseQA/RAG/corpusManifest.js";

const HELP = `Usage: node scripts/refresh-corpus-manifest.js [options]

Recomputes content_sha256 for every manifest row from the PDFs on disk.
retrieved_at, pdf_url and upstream_revision are updated ONLY for rows whose
bytes actually changed, so a no-op refresh leaves corpus_manifest.csv
byte-identical and does not trigger a re-ingest.

A write goes to a temp file and is renamed into place, and the previous good
manifest is kept at corpus_manifest.csv.bak (overwritten each time a write
happens). That single rolling backup is committed alongside the manifest and is
the only backup the corpus keeps.

Options:
  --corpus-root=<path>  Corpus directory (default: RAG_CORPUS_ROOT or auto-detected)
  --dry-run             Report what would change without writing
  --help                Show this help`;

const parseArgs = (argv) =>
  argv.reduce(
    (options, argument) => {
      if ( argument === "--help" || argument === "-h" ) {
        return { ...options, help: true };
      }
      if ( argument === "--dry-run" ) {
        return { ...options, dryRun: true };
      }
      if ( argument.startsWith("--corpus-root=") ) {
        return {
          ...options,
          corpusRoot: path.resolve(argument.slice("--corpus-root=".length)),
        };
      }
      // Silently ignoring an unknown flag means a typo like --dry-runn
      // performs a real write while the operator believes otherwise.
      throw new Error(`Unknown argument: ${argument}`);
    },
    { help: false, dryRun: false, corpusRoot: null },
  );

const readUpstreamState = async (statePath) => {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch ( error ) {
    if ( error?.code === "ENOENT" ) {
      return { entries: {} };
    }
    throw error;
  }
};

// parseManifestCsv throws an opaque TypeError on blank input; say what is
// actually wrong instead.
const requireUsableManifest = ({ manifestText, manifestPath }) => {
  if ( manifestText.trim() === "" ) {
    throw new Error(`Manifest is empty: ${manifestPath}`);
  }
  return manifestText;
};

// Git holds the committed history, but an uncommitted refresh still overwrites
// the working copy in place. Keep a rolling backup of the previous good file and
// swap the new one in with an atomic rename, so a crash mid-write cannot leave a
// truncated manifest behind.
const writeManifestSafely = async ({ manifestPath, text }) => {
  const backupPath = `${manifestPath}.bak`;
  await fs.copyFile(manifestPath, backupPath);

  const tempPath = `${manifestPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tempPath, text);
    await fs.rename(tempPath, manifestPath);
  } catch ( error ) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
  return backupPath;
};

const hashCorpusFiles = async ({ corpusRoot, rows }) => {
  const hashes = {};
  for ( const row of rows ) {
    try {
      const buffer = await fs.readFile(path.resolve(corpusRoot, row.file_path));
      hashes[row.file_path] = createHash("sha256").update(buffer).digest("hex");
    } catch ( error ) {
      if ( error?.code !== "ENOENT" ) {
        throw error;
      }
    }
  }
  return hashes;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if ( options.help ) {
    console.log(HELP);
    return 0;
  }

  const corpusRoot = options.corpusRoot || resolveCorpusRoot();
  const manifestPath = path.join(corpusRoot, "corpus_manifest.csv");
  const statePath = path.join(corpusRoot, "upstream_state.json");

  const manifestText = requireUsableManifest({
    manifestText: await fs.readFile(manifestPath, "utf8"),
    manifestPath,
  });
  const rows = parseManifestCsv(manifestText);
  const hashes = await hashCorpusFiles({ corpusRoot, rows });
  const upstreamState = await readUpstreamState(statePath);

  const plan = planManifestRefresh({
    rows,
    hashes,
    upstreamState,
    now: new Date(),
  });

  console.log(
    JSON.stringify(
      {
        event: "corpus_manifest_refresh",
        corpusRoot,
        unchanged: plan.unchanged,
        changed: plan.changed.map((entry) => entry.fileName),
        dryRun: options.dryRun,
      },
      null,
      2,
    ),
  );

  if ( plan.changed.length === 0 ) {
    console.log("Manifest already matches the PDFs on disk; nothing written.");
    return 0;
  }
  if ( options.dryRun ) {
    return 0;
  }

  // Serialize before touching anything on disk: a value the parser could not
  // read back throws here, leaving the manifest untouched.
  const nextText = serializeManifestCsv(plan.rows);
  const backupPath = await writeManifestSafely({ manifestPath, text: nextText });
  console.log(`Previous manifest kept at ${backupPath}`);
  console.log(`Wrote ${manifestPath}. Next: npm run ingest:rag`);
  return 0;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("Corpus manifest refresh failed:", error);
    process.exitCode = 1;
  });
