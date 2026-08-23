import "dotenv/config";
import mongoose from "mongoose";
import { ingestKnowledgeCorpus } from "../LeaseQA/RAG/service.js";

const parseArguments = (argv) =>
  argv.reduce(
    (options, argument) => {
      if ( argument === "--reset" ) {
        return { ...options, reset: true };
      }
      if ( argument === "--no-gate" ) {
        return { ...options, gate: false };
      }
      if ( argument.startsWith("--min-hit-rate=") ) {
        const value = Number.parseFloat(argument.slice("--min-hit-rate=".length));
        if ( Number.isFinite(value) && value >= 0 && value <= 1 ) {
          return { ...options, minHitRate: value };
        }
      }
      if ( argument.startsWith("--limit=") ) {
        const value = Number.parseInt(argument.slice("--limit=".length), 10);
        if ( Number.isFinite(value) && value > 0 ) {
          return { ...options, limit: value };
        }
      }
      return options;
    },
    { reset: false, limit: null, gate: true, minHitRate: null },
  );

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if ( options.gate === false ) {
    process.env.RAG_INGEST_GATE = "off";
  }
  if ( options.minHitRate !== null ) {
    process.env.RAG_INGEST_GATE_MIN_HIT_RATE = String(options.minHitRate);
  }

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
