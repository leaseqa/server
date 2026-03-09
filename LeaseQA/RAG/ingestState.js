import fs from "fs/promises";

const STATE_VERSION = 1;

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
    if (!parsed || parsed.version !== STATE_VERSION) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
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
  await fs.writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
};

export const clearIngestState = async ({ statePath }) => {
  try {
    await fs.unlink(statePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
};
