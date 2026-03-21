import * as studyDao from "./dao.js";
import { getScenarioById as defaultGetScenarioById } from "./scenarios.js";
import {
  answerQuestion,
  createRagSession,
  getViewerSession,
} from "../RAG/service.js";

export const STUDY_CONDITIONS = [
  {
    conditionId: "condition-low-professional_personalized",
    boundaryCue: "low",
    framing: "professional_personalized",
  },
  {
    conditionId: "condition-low-informational_detached",
    boundaryCue: "low",
    framing: "informational_detached",
  },
  {
    conditionId: "condition-high-professional_personalized",
    boundaryCue: "high",
    framing: "professional_personalized",
  },
  {
    conditionId: "condition-high-informational_detached",
    boundaryCue: "high",
    framing: "informational_detached",
  },
];

export const assignCondition = ({ participantId, scenarioId }) => {
  const key = `${participantId}:${scenarioId}`;
  let hash = 0;

  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
  }

  return STUDY_CONDITIONS[hash % STUDY_CONDITIONS.length];
};

export const getStudyMaxFollowUps = (env = process.env) => {
  const parsed = Number.parseInt(env.STUDY_MAX_FOLLOW_UPS || "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
};

const buildRemainingFollowUps = ({ turnCount, maxFollowUps }) =>
  Math.max(0, maxFollowUps - Math.max(0, turnCount - 1));

const buildScenarioView = (scenario) => ({
  scenarioId: scenario.scenarioId,
  title: scenario.title,
  introduction: scenario.introduction,
  taskInstructions: scenario.taskInstructions,
  mainQuestion: scenario.mainQuestion,
});

const buildStudyView = ({ studySession, ragSession, scenario, maxFollowUps }) => ({
  ...studySession,
  studySessionId: studySession?._id?.toString?.() || studySession?._id,
  ragSession,
  scenario: buildScenarioView(scenario),
  maxFollowUps,
  remainingFollowUps: buildRemainingFollowUps({
    turnCount: studySession.turnCount || 0,
    maxFollowUps,
  }),
});

export const createStudyService = ({
  studyDao: studyDaoImpl = studyDao,
  ragService = {
    createRagSession,
    answerQuestion,
    getViewerSession,
  },
  getScenarioById = defaultGetScenarioById,
  assignCondition: assignConditionImpl = assignCondition,
  maxFollowUps = getStudyMaxFollowUps(),
} = {}) => ({
  async createStudySession({ participantId, scenarioId, userId = null, clientSessionId }) {
    const reusableSession = await studyDaoImpl.findReusableStudySession?.({
      participantId,
      scenarioId,
    });
    const scenario = getScenarioById(scenarioId);

    if (reusableSession?.ragSessionId) {
      const ragSession = await ragService.getViewerSession({
        sessionId: reusableSession.ragSessionId,
        userId,
        clientSessionId,
      });
      return buildStudyView({
        studySession: reusableSession,
        ragSession,
        scenario,
        maxFollowUps,
      });
    }

    const condition = assignConditionImpl({ participantId, scenarioId });
    const createdStudySession = await studyDaoImpl.createStudySession({
      participantId,
      scenarioId,
      ...condition,
    });
    const ragSession = await ragService.createRagSession({
      userId,
      clientSessionId,
      sourceText: scenario.sourceText,
      studyMetadata: {
        studySessionId: createdStudySession._id.toString(),
        studyConditionId: condition.conditionId,
        studyScenarioId: scenarioId,
        studyFraming: condition.framing,
      },
    });
    const updatedStudySession = await studyDaoImpl.updateStudySession(
      createdStudySession._id,
      {
        ragSessionId: ragSession._id.toString(),
      },
    );

    return buildStudyView({
      studySession: updatedStudySession,
      ragSession,
      scenario,
      maxFollowUps,
    });
  },

  async getStudySession({
    studySessionId,
    userId = null,
    clientSessionId,
  }) {
    const studySession = await studyDaoImpl.findStudySessionById(studySessionId);
    if (!studySession) {
      throw new Error("Study session not found");
    }
    const scenario = getScenarioById(studySession.scenarioId);
    const ragSession = studySession.ragSessionId
      ? await ragService.getViewerSession({
          sessionId: studySession.ragSessionId,
          userId,
          clientSessionId,
        })
      : null;

    return buildStudyView({
      studySession,
      ragSession,
      scenario,
      maxFollowUps,
    });
  },

  async sendStudyMessage({
    studySessionId,
    message,
    userId = null,
    clientSessionId,
  }) {
    const trimmedMessage = String(message || "").trim();
    if (!trimmedMessage) {
      throw new Error("Message is required");
    }

    const studySession = await studyDaoImpl.findStudySessionById(studySessionId);
    if (!studySession) {
      throw new Error("Study session not found");
    }
    if (studySession.status !== "active") {
      throw new Error("Study session is already completed");
    }
    if (!studySession.ragSessionId) {
      throw new Error("Study session is not ready yet");
    }

    const scenario = getScenarioById(studySession.scenarioId);
    const totalAllowedTurns = maxFollowUps + 1;

    if (
      studySession.turnCount === 0 &&
      trimmedMessage !== scenario.mainQuestion.trim()
    ) {
      throw new Error("The first study turn must use the fixed main question");
    }

    if ((studySession.turnCount || 0) >= totalAllowedTurns) {
      throw new Error("The follow-up limit has been reached");
    }

    const ragResult = await ragService.answerQuestion({
      sessionId: studySession.ragSessionId,
      userId,
      clientSessionId,
      question: trimmedMessage,
      studyFraming: studySession.framing,
    });

    const updatedStudySession = await studyDaoImpl.incrementTurnCount(
      studySessionId,
      (studySession.turnCount || 0) + 1,
    );

    return {
      studySession: buildStudyView({
        studySession: updatedStudySession,
        ragSession: ragResult.session,
        scenario,
        maxFollowUps,
      }),
      answer: ragResult.answer,
      citations: ragResult.citations,
    };
  },

  async completeStudySession({ studySessionId }) {
    const studySession = await studyDaoImpl.completeStudySession(studySessionId);
    if (!studySession) {
      throw new Error("Study session not found");
    }

    return studySession;
  },
});

const studyService = createStudyService();

export default studyService;
