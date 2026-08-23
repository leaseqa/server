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
      return options;
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

  const rows = parseManifestCsv(await fs.readFile(manifestPath, "utf8"));
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

  await fs.writeFile(manifestPath, serializeManifestCsv(plan.rows));
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
