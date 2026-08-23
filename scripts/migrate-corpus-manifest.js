import "dotenv/config";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveCorpusRoot } from "../LeaseQA/RAG/config.js";
import {
  MANIFEST_COLUMNS,
  parseManifestCsv,
  readManifestHeader,
  serializeManifestCsv,
} from "../LeaseQA/RAG/corpusManifest.js";

const DEFAULT_SEED_DATE = "2026-03-01";
const BACKUP_SUFFIX = ".pre-migration.bak";

const HELP = `Usage: node scripts/migrate-corpus-manifest.js [options]

One-shot migration that appends the provenance columns
(pdf_url, content_sha256, retrieved_at, upstream_revision) to
corpus_manifest.csv. content_sha256 comes from each PDF's bytes on disk,
upstream_revision is seeded from the row's existing title_hint, and pdf_url is
left empty for scripts/check-corpus-upstream.js to discover.

Idempotent: a manifest whose header already carries content_sha256 is left
untouched. The original file is copied to corpus_manifest.csv${BACKUP_SUFFIX}
before the first write.

Options:
  --corpus-root=<path>     Corpus directory (default: RAG_CORPUS_ROOT or auto-detected)
  --seed-date=YYYY-MM-DD   retrieved_at for every row (default: ${DEFAULT_SEED_DATE})
  --dry-run                Report what would change without writing
  --help                   Show this help`;

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
      if ( argument.startsWith("--seed-date=") ) {
        return {
          ...options,
          seedDate: argument.slice("--seed-date=".length),
        };
      }
      throw new Error(`Unknown argument: ${argument}`);
    },
    {
      help: false,
      dryRun: false,
      corpusRoot: null,
      seedDate: DEFAULT_SEED_DATE,
    },
  );

// Shape alone lets 2026-13-45 through and stamps it onto every row. Date.parse
// rejects that but silently rolls 2026-02-30 over to 2026-03-02, so compare the
// round-trip instead; that still accepts a real leap day like 2024-02-29.
const requireIsoDate = (value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(
      `--seed-date must be a valid YYYY-MM-DD calendar date, received "${value}"`,
    );
  }
  return value;
};

// parseManifestCsv throws an opaque TypeError on blank input; say what is
// actually wrong instead.
const requireUsableManifest = ({ manifestText, manifestPath }) => {
  if ( manifestText.trim() === "" ) {
    throw new Error(`Manifest is empty: ${manifestPath}`);
  }
  return manifestText;
};

const isMigrated = (manifestText) =>
  readManifestHeader(manifestText).includes("content_sha256");

// serializeManifestCsv only ever emits MANIFEST_COLUMNS, so a pre-migration
// header carrying anything else would be silently dropped on write.
const requireKnownHeader = (manifestText) => {
  const unknown = readManifestHeader(manifestText).filter(
    (column) => !MANIFEST_COLUMNS.includes(column),
  );
  if ( unknown.length > 0 ) {
    throw new Error(
      `Manifest header carries columns this migration cannot preserve: ${unknown.join(", ")}`,
    );
  }
};

const hashRowFile = async ({ corpusRoot, row }) => {
  const filePath = path.resolve(corpusRoot, row.file_path);
  try {
    const buffer = await fs.readFile(filePath);
    return createHash("sha256").update(buffer).digest("hex");
  } catch ( error ) {
    if ( error?.code === "ENOENT" ) {
      throw new Error(
        `Local file missing for manifest row ${row.file_name} (${row.file_path}); refusing to write an empty content_sha256`,
      );
    }
    throw error;
  }
};

const migrateRows = async ({ corpusRoot, rows, seedDate }) => {
  const migrated = [];
  for ( const row of rows ) {
    migrated.push({
      ...row,
      pdf_url: "",
      content_sha256: await hashRowFile({ corpusRoot, row }),
      retrieved_at: seedDate,
      upstream_revision: row.title_hint || "",
    });
  }
  return migrated;
};

const backUpManifest = async (manifestPath) => {
  const backupPath = `${manifestPath}${BACKUP_SUFFIX}`;
  try {
    await fs.copyFile(manifestPath, backupPath, fs.constants.COPYFILE_EXCL);
    return { backupPath, created: true };
  } catch ( error ) {
    if ( error?.code === "EEXIST" ) {
      return { backupPath, created: false };
    }
    throw error;
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  if ( options.help ) {
    console.log(HELP);
    return 0;
  }

  const seedDate = requireIsoDate(options.seedDate);
  const corpusRoot = options.corpusRoot || resolveCorpusRoot();
  const manifestPath = path.join(corpusRoot, "corpus_manifest.csv");
  const manifestText = requireUsableManifest({
    manifestText: await fs.readFile(manifestPath, "utf8"),
    manifestPath,
  });

  if ( isMigrated(manifestText) ) {
    console.log(
      JSON.stringify(
        {
          event: "corpus_manifest_migration",
          corpusRoot,
          status: "already_migrated",
          dryRun: options.dryRun,
        },
        null,
        2,
      ),
    );
    console.log("Header already carries content_sha256; nothing written.");
    return 0;
  }

  requireKnownHeader(manifestText);
  const rows = parseManifestCsv(manifestText);
  const migratedRows = await migrateRows({ corpusRoot, rows, seedDate });
  const nextText = serializeManifestCsv(migratedRows);

  console.log(
    JSON.stringify(
      {
        event: "corpus_manifest_migration",
        corpusRoot,
        status: options.dryRun ? "planned" : "writing",
        rows: migratedRows.length,
        seedDate,
        addedColumns: MANIFEST_COLUMNS.slice(8),
        bytesBefore: Buffer.byteLength(manifestText, "utf8"),
        bytesAfter: Buffer.byteLength(nextText, "utf8"),
        normalizesLineEndings: manifestText.includes("\r\n"),
        dryRun: options.dryRun,
      },
      null,
      2,
    ),
  );

  if ( manifestText.includes("\r\n") ) {
    console.log(
      `Line endings will be normalised CRLF -> LF. This does not avoid a re-embed`
        + ` (the manifest text changes either way), but it puts the file in the exact`
        + ` form serializeManifestCsv emits, so a later partial refresh rewrites only`
        + ` the rows that actually changed instead of all ${migratedRows.length}.`,
    );
  }

  if ( options.dryRun ) {
    console.log(nextText.split("\n").slice(0, 3).join("\n"));
    console.log("Dry run; nothing written.");
    return 0;
  }

  const backup = await backUpManifest(manifestPath);
  console.log(
    backup.created
      ? `Backed up original manifest to ${backup.backupPath}`
      : `Backup already present at ${backup.backupPath}; kept as-is`,
  );

  await fs.writeFile(manifestPath, nextText);
  console.log(
    `Wrote ${manifestPath} (${migratedRows.length} rows). Next: node scripts/refresh-corpus-manifest.js --dry-run`,
  );
  return 0;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("Corpus manifest migration failed:", error);
    process.exitCode = 1;
  });
