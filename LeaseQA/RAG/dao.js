import model from "./model.js";

export const createSession = (payload) =>
  model.create({
    userId: payload.userId || null,
    clientSessionId: payload.clientSessionId,
    status: payload.status || "indexing",
    error: payload.error || null,
    sourceKind: payload.sourceKind,
    sourceName: payload.sourceName,
    sourceMimeType: payload.sourceMimeType || null,
    sourceTextPreview: payload.sourceTextPreview,
    sourceCharCount: payload.sourceCharCount,
    studySessionId: payload.studySessionId || null,
    studyConditionId: payload.studyConditionId || null,
    studyScenarioId: payload.studyScenarioId || null,
    studyFraming: payload.studyFraming || null,
    messages: payload.messages || [],
  });

export const updateSession = (sessionId, payload) =>
  model.findByIdAndUpdate(sessionId, payload, { new: true });

export const appendMessages = (sessionId, messages) =>
  model.findByIdAndUpdate(
    sessionId,
    { $push: { messages: { $each: messages } } },
    { new: true },
  );

export const findSessionById = (sessionId) => model.findById(sessionId);

export const listSessionsForViewer = ({ userId, clientSessionId }) => {
  if (userId) {
    return model.find({ userId }).sort({ updatedAt: -1 }).limit(20);
  }
  return model
    .find({ userId: null, clientSessionId })
    .sort({ updatedAt: -1 })
    .limit(20);
};
