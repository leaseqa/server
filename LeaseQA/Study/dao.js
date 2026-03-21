import model from "./model.js";

export const createStudySession = (payload) =>
  model.create({
    participantId: payload.participantId,
    scenarioId: payload.scenarioId,
    conditionId: payload.conditionId,
    boundaryCue: payload.boundaryCue,
    framing: payload.framing,
    ragSessionId: payload.ragSessionId || null,
    turnCount: payload.turnCount || 0,
    status: payload.status || "active",
    completedAt: payload.completedAt || null,
  });

export const findReusableStudySession = ({ participantId, scenarioId }) =>
  model
    .findOne({
      participantId,
      scenarioId,
      status: "active",
    })
    .sort({ updatedAt: -1 });

export const findStudySessionById = (studySessionId) => model.findById(studySessionId);

export const updateStudySession = (studySessionId, payload) =>
  model.findByIdAndUpdate(studySessionId, payload, { new: true });

export const incrementTurnCount = (studySessionId, nextTurnCount) =>
  model.findByIdAndUpdate(studySessionId, { turnCount: nextTurnCount }, { new: true });

export const completeStudySession = (studySessionId) =>
  model.findByIdAndUpdate(
    studySessionId,
    {
      status: "completed",
      completedAt: new Date(),
    },
    { new: true },
  );

