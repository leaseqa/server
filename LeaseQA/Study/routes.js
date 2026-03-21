import express from "express";
import { z } from "zod";

import studyService from "./service.js";
import { sendData, sendError, sendNotFound } from "../utils/responses.js";

const createSessionSchema = z.object({
  participantId: z.string().trim().min(1, "participantId is required"),
  scenarioId: z.string().trim().min(1, "scenarioId is required"),
});

const messageSchema = z.object({
  message: z.string().trim().min(1, "Message is required"),
});

const getErrorStatus = (error) => {
  if (error instanceof z.ZodError) {
    return 400;
  }
  if (error.message === "Study session not found") {
    return 404;
  }
  if (error.message?.includes("access")) {
    return 403;
  }
  if (
    error.message?.includes("required") ||
    error.message?.includes("fixed main question") ||
    error.message?.includes("follow-up limit") ||
    error.message?.includes("Unknown study scenario") ||
    error.message?.includes("already completed") ||
    error.message?.includes("not ready")
  ) {
    return 400;
  }
  return 500;
};

export const createStudyRouter = (service = studyService) => {
  const router = express.Router();

  router.use((req, _res, next) => {
    if (!req.session?.currentUser && !req.session?.ragGuest) {
      req.session.ragGuest = { createdAt: new Date().toISOString() };
    }
    next();
  });

  router.post("/sessions", async (req, res) => {
    try {
      const { participantId, scenarioId } = createSessionSchema.parse(req.body);
      const session = await service.createStudySession({
        participantId,
        scenarioId,
        userId: req.session?.currentUser?._id || null,
        clientSessionId: req.sessionID,
      });

      sendData(res, session, 201);
    } catch (error) {
      const status = getErrorStatus(error);
      sendError(res, {
        code: status === 400 ? "VALIDATION_ERROR" : "STUDY_CREATE_FAILED",
        message: error.message || "Failed to create study session.",
        status,
      });
    }
  });

  router.get("/sessions/:studySessionId", async (req, res) => {
    try {
      const session = await service.getStudySession({
        studySessionId: req.params.studySessionId,
        userId: req.session?.currentUser?._id || null,
        clientSessionId: req.sessionID,
      });
      sendData(res, session);
    } catch (error) {
      const status = getErrorStatus(error);
      if (status === 404) {
        return sendNotFound(res, "Study session not found");
      }
      sendError(res, {
        code: status === 403 ? "FORBIDDEN" : "STUDY_SESSION_FAILED",
        message: error.message,
        status,
      });
    }
  });

  router.post("/sessions/:studySessionId/messages", async (req, res) => {
    try {
      const { message } = messageSchema.parse(req.body);
      const result = await service.sendStudyMessage({
        studySessionId: req.params.studySessionId,
        message,
        userId: req.session?.currentUser?._id || null,
        clientSessionId: req.sessionID,
      });
      sendData(res, result);
    } catch (error) {
      const status = getErrorStatus(error);
      if (status === 404) {
        return sendNotFound(res, "Study session not found");
      }
      sendError(res, {
        code:
          status === 400
            ? "VALIDATION_ERROR"
            : status === 403
              ? "FORBIDDEN"
              : "STUDY_MESSAGE_FAILED",
        message: error.message || "Failed to answer study question.",
        status,
      });
    }
  });

  router.post("/sessions/:studySessionId/complete", async (req, res) => {
    try {
      const session = await service.completeStudySession({
        studySessionId: req.params.studySessionId,
      });

      sendData(res, session);
    } catch (error) {
      const status = getErrorStatus(error);
      if (status === 404) {
        return sendNotFound(res, "Study session not found");
      }
      sendError(res, {
        code: "STUDY_COMPLETE_FAILED",
        message: error.message || "Failed to complete study session.",
        status,
      });
    }
  });

  return router;
};

export default createStudyRouter();

