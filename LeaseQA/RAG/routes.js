import express from "express";
import multer from "multer";
import { z } from "zod";
import { sendData, sendError, sendNotFound } from "../utils/responses.js";
import {
  answerQuestion,
  createSessionWithOptionalInitialAnswer,
  getViewerSession,
  listViewerSessions,
} from "./service.js";

const router = express.Router();
export const getUploadMaxBytes = (env = process.env) =>
  Number.parseInt(env.RAG_UPLOAD_MAX_BYTES || "", 10) || 20 * 1024 * 1024;
export const normalizeResponseFraming = (value) =>
  value === "professional_personalized"
    ? "professional_personalized"
    : "informational_detached";
export const buildSessionStudyMetadata = ({
  participantId = "",
  participantSource = "",
  conditionId = "",
  scenarioId = "",
  responseFraming,
}) => {
  const normalizedParticipantId = participantId.trim();
  const normalizedParticipantSource = participantSource.trim();
  const normalizedConditionId = conditionId.trim();
  const normalizedScenarioId = scenarioId.trim();
  const normalizedFraming = responseFraming
    ? normalizeResponseFraming(responseFraming)
    : null;

  if (
    !normalizedParticipantId &&
    !normalizedConditionId &&
    !normalizedScenarioId &&
    !normalizedFraming
  ) {
    return null;
  }

  return {
    studyParticipantId: normalizedParticipantId || null,
    studyParticipantSource:
      normalizedParticipantId && normalizedParticipantSource
        ? normalizedParticipantSource
        : null,
    studyConditionId: normalizedConditionId || null,
    studyScenarioId: normalizedScenarioId || null,
    studyFraming: normalizedFraming,
  };
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: getUploadMaxBytes(),
  },
});

router.use((req, _res, next) => {
  if (!req.session?.currentUser && !req.session?.ragGuest) {
    req.session.ragGuest = { createdAt: new Date().toISOString() };
  }
  next();
});

const createSessionSchema = z.object({
  sourceText: z.string().trim().optional().default(""),
  initialQuestion: z.string().optional(),
  responseFraming: z.string().optional(),
  participantId: z.string().trim().optional().default(""),
  participantSource: z.string().trim().optional().default(""),
  conditionId: z.string().trim().optional().default(""),
  scenarioId: z.string().trim().optional().default(""),
});

const messageSchema = z.object({
  message: z.string().trim().min(1, "Message is required"),
  responseFraming: z.string().optional(),
});

const getErrorStatus = (error) => {
  if (error instanceof z.ZodError) {
    return 400;
  }
  if (error.message === "Session not found") {
    return 404;
  }
  if (error.message?.includes("access")) {
    return 403;
  }
  if (
    error.message?.includes("Unsupported file type") ||
    error.message?.includes("No readable text found") ||
    error.message?.includes("not ready") ||
    error.message?.includes("not supported yet")
  ) {
    return 400;
  }
  return 500;
};

router.get("/sessions", async (req, res) => {
  try {
    const sessions = await listViewerSessions({
      userId: req.session?.currentUser?._id || null,
      clientSessionId: req.sessionID,
    });
    sendData(res, sessions);
  } catch (error) {
    console.error("[RAG] Failed to list sessions:", error);
    sendError(res, {
      code: "RAG_LIST_FAILED",
      message: "Failed to load chat sessions.",
      status: 500,
    });
  }
});

router.get("/sessions/:sessionId", async (req, res) => {
  try {
    const session = await getViewerSession({
      sessionId: req.params.sessionId,
      userId: req.session?.currentUser?._id || null,
      clientSessionId: req.sessionID,
    });
    sendData(res, session);
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 404) {
      return sendNotFound(res, "Chat session not found");
    }
    sendError(res, {
      code: status === 403 ? "FORBIDDEN" : "RAG_SESSION_FAILED",
      message: error.message,
      status,
    });
  }
});

router.post("/sessions", upload.single("file"), async (req, res) => {
  try {
    const {
      sourceText,
      initialQuestion: rawInitialQuestion,
      responseFraming: rawResponseFraming,
      participantId,
      participantSource,
      conditionId,
      scenarioId,
    } =
      createSessionSchema.parse(req.body);
    if (!sourceText && !req.file) {
      return sendError(res, {
        code: "VALIDATION_ERROR",
        message: "Provide sourceText or upload a file.",
        status: 400,
      });
    }

    const studyMetadata = buildSessionStudyMetadata({
      participantId,
      participantSource,
      conditionId,
      scenarioId,
      responseFraming: rawResponseFraming,
    });

    const session = await createSessionWithOptionalInitialAnswer({
      userId: req.session?.currentUser?._id || null,
      clientSessionId: req.sessionID,
      sourceText,
      file: req.file || null,
      initialQuestion: rawInitialQuestion,
      responseFraming: rawResponseFraming
        ? normalizeResponseFraming(rawResponseFraming)
        : null,
      studyMetadata,
    });
    sendData(res, session, 201);
  } catch (error) {
    console.error("[RAG] Failed to create session:", error);
    const status = getErrorStatus(error);
    sendError(res, {
      code: status === 400 ? "VALIDATION_ERROR" : "RAG_CREATE_FAILED",
      message: error.message || "Failed to start chat session.",
      status,
    });
  }
});

router.post("/sessions/:sessionId/messages", async (req, res) => {
  try {
    const { message, responseFraming: rawResponseFraming } =
      messageSchema.parse(req.body);
    const result = await answerQuestion({
      sessionId: req.params.sessionId,
      userId: req.session?.currentUser?._id || null,
      clientSessionId: req.sessionID,
      question: message,
      responseFraming: normalizeResponseFraming(rawResponseFraming),
    });
    sendData(res, result);
  } catch (error) {
    const status = getErrorStatus(error);
    if (status === 404) {
      return sendNotFound(res, "Chat session not found");
    }
    sendError(res, {
      code:
        status === 400
          ? "VALIDATION_ERROR"
          : status === 403
            ? "FORBIDDEN"
            : "RAG_MESSAGE_FAILED",
      message: error.message || "Failed to answer question.",
      status,
    });
  }
});

export default router;
