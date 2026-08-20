import { createHash } from "node:crypto";
import fs from "fs/promises";

const STATE_VERSION = 2;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const buildCorpusIdentity = ({
  manifestContents,
  sourceHashes,
  embeddingFingerprint = "",
}) => {
  const sortedSourceHashes = [...sourceHashes].sort();
  const identityParts = [
    manifestContents,
    sortedSourceHashes.join("\n"),
  ];
  if ( embeddingFingerprint ) {
    identityParts.push(embeddingFingerprint);
  }
  return {
    manifestSha256: sha256(manifestContents),
    corpusVersion: sha256(identityParts.join("\n")),
  };
};

const buildInitialState = ({ collectionName, manifestPath }) => ({
  version: STATE_VERSION,
  collectionName,
  manifestPath,
  nextIndex: 0,
  lastCompletedFile: null,
  updatedAt: new Date().toISOString(),
});

export const createInitialIngestState = ({ collectionName, manifestPath }) =>
  buildInitialState({ collectionName, manifestPath });

export const readIngestState = async ({ statePath }) => {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    if ( !parsed || parsed.version !== STATE_VERSION ) {
      return null;
    }
    return parsed;
  } catch ( error ) {
    if ( error?.code === "ENOENT" ) {
      return null;
    }
    throw error;
  }
};

export const writeIngestState = async ({ statePath, state }) => {
  const nextState = {
    ...state,
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(nextState, null, 2)}\n`);
  await fs.rename(temporaryPath, statePath);
  return nextState;
};

export const readActiveCorpusVersion = async ({ statePath }) => {
  const state = await readIngestState({ statePath });
  return state?.status === "active" ? state.corpusVersion || null : null;
};

export const clearIngestState = async ({ statePath }) => {
  try {
    await fs.unlink(statePath);
  } catch ( error ) {
    if ( error?.code !== "ENOENT" ) {
      throw error;
    }
  }
};
