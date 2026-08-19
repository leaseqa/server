import "dotenv/config";
import mongoose from "mongoose";
import { ingestKnowledgeCorpus } from "../LeaseQA/RAG/service.js";

const parseArguments = (argv) =>
  argv.reduce(
    (options, argument) => {
      if ( argument === "--reset" ) {
        return { ...options, reset: true };
      }
      if ( argument.startsWith("--limit=") ) {
        const value = Number.parseInt(argument.slice("--limit=".length), 10);
        if ( Number.isFinite(value) && value > 0 ) {
          return { ...options, limit: value };
        }
      }
      return options;
    },
    { reset: false, limit: null },
  );

const main = async () => {
  await mongoose.connect(process.env.DATABASE_CONNECTION_STRING);
  try {
    const options = parseArguments(process.argv.slice(2));
    const state = await ingestKnowledgeCorpus(options);
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
  console.error("Knowledge corpus ingestion failed:", error);
  process.exit(1);
});
