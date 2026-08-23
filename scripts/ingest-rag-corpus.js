import "dotenv/config";
import { pathToFileURL } from "node:url";
import mongoose from "mongoose";

import { resolveCorpusRoot } from "../LeaseQA/RAG/config.js";
import { ingestKnowledgeCorpus } from "../LeaseQA/RAG/service.js";

const HELP = `Usage: node scripts/ingest-rag-corpus.js [options]

Embeds every manifest row into a fresh staging collection, runs the retrieval
gate against that staging collection, and only then moves the alias named by
RAG_MILVUS_KNOWLEDGE_COLLECTION. A failed gate leaves the staging collection in
place for inspection and exits 2 without moving the alias.

Options:
  --reset               Restart the current staging version from the first file
  --no-gate             Skip the retrieval gate (sets RAG_INGEST_GATE=off)
  --limit=<n>           Embed at most n more files, then stop before activating
  --min-hit-rate=<0-1>  Gate threshold as a fraction, not a percentage
  --help                Show this help`;

export const parseArguments = (argv) =>
  argv.reduce(
    (options, argument) => {
      if ( argument === "--help" || argument === "-h" ) {
        return { ...options, help: true };
      }
      if ( argument === "--reset" ) {
        return { ...options, reset: true };
      }
      if ( argument === "--no-gate" ) {
        return { ...options, gate: false };
      }
      if ( argument.startsWith("--min-hit-rate=") ) {
        const raw = argument.slice("--min-hit-rate=".length);
        const value = Number.parseFloat(raw);
        // Discarding an out-of-range value ran the gate at the 0.9 default
        // while the operator believed they had asked for something else.
        if ( !Number.isFinite(value) || value < 0 || value > 1 ) {
          throw new Error(
            `--min-hit-rate needs a fraction between 0 and 1, got ${JSON.stringify(raw)}. 95% is 0.95, not 95.`,
          );
        }
        return { ...options, minHitRate: value };
      }
      if ( argument.startsWith("--limit=") ) {
        const raw = argument.slice("--limit=".length);
        const value = Number.parseInt(raw, 10);
        if ( !Number.isFinite(value) || value <= 0 ) {
          throw new Error(
            `--limit needs a positive integer, got ${JSON.stringify(raw)}.`,
          );
        }
        return { ...options, limit: value };
      }
      // The four sibling CLIs all refuse an unknown argument, and this one has
      // the most to lose by guessing: `--limit 5`, a space instead of `=`, used
      // to fall through here and ingest all 81 files, run the gate, and repoint
      // the production alias -- the opposite of the smoke test being asked for.
      throw new Error(`Unknown argument: ${argument}`);
    },
    { help: false, reset: false, limit: null, gate: true, minHitRate: null },
  );

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if ( options.help ) {
    console.log(HELP);
    return;
  }
  if ( options.gate === false ) {
    process.env.RAG_INGEST_GATE = "off";
  }
  if ( options.minHitRate !== null ) {
    process.env.RAG_INGEST_GATE_MIN_HIT_RATE = String(options.minHitRate);
  }

  // A pre-migration copy of the corpus may still exist outside this repository.
  // This is the command that spends the embedding budget and moves the alias,
  // so print the root it resolved before doing either: CORPUS_GUIDE.md tells
  // the operator to stop if it is not inside this checkout.
  console.log(`[RAG ingest] corpusRoot: ${resolveCorpusRoot()}`);

  await mongoose.connect(process.env.DATABASE_CONNECTION_STRING);
  try {
    const state = await ingestKnowledgeCorpus({
      reset: options.reset,
      limit: options.limit,
    });
    console.log(
      JSON.stringify({
        event: "rag_ingest_complete",
        status: state.status,
        corpusVersion: state.corpusVersion,
        collectionName: state.collectionName,
        alias: state.alias,
        nextIndex: state.nextIndex,
      }),
    );
  } finally {
    await mongoose.disconnect();
  }
};

// Importing this file must never start an ingest, so the tests can exercise
// parseArguments the way they do for scripts/format-upstream-issue.js.
const isExecutedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if ( isExecutedDirectly ) {
  main().catch((error) => {
    if ( error?.code === "RAG_INGEST_GATE_FAILED" ) {
      console.error(
        JSON.stringify({
          event: "rag_ingest_blocked",
          reason: error.message,
          gate: error.gate,
        }),
      );
      process.exit(2);
    }
    console.error("Knowledge corpus ingestion failed:", error);
    process.exit(1);
  });
}
