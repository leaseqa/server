import express from "express";
import multer from "multer";
import { z } from "zod";
import { sendData, sendError, sendNotFound } from "../utils/responses.js";
import {
  acceptsEventStream,
  createEventStream,
  saveSessionBeforeStream,
} from "../utils/eventStream.js";
import {
  answerQuestion,
  createSessionWithOptionalInitialAnswer,
  deleteViewerSession,
  getStableRagErrorCode,
  getViewerSession,
  listViewerSessions,
} from "./service.js";

export const getUploadMaxBytes = (env = process.env) =>
  Number.parseInt(env.RAG_UPLOAD_MAX_BYTES || "", 10) || 20 * 1024 * 1024;

const RAG_GUEST_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const createGuestSessionMetadata = (now = new Date()) => ({
  createdAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + RAG_GUEST_RETENTION_MS).toISOString(),
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: getUploadMaxBytes(),
  },
});

const createSessionSchema = z.object({
  sourceText: z.string().trim().optional().default(""),
  initialQuestion: z.string().optional(),
});

const messageSchema = z.object({
  message: z.string().trim().min(1, "Message is required"),
});

const getErrorStatus = (error) => {
  if ( error instanceof z.ZodError ) {
    return 400;
  }
  if ( error.message === "Session not found" ) {
    return 404;
  }
  if ( error.code === "RAG_SESSION_DELETE_RETRYABLE" ) {
    return 503;
  }
  if ( error.message?.includes("access") ) {
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

export const createRagRouter = (dependencies = {}) => {
  const router = express.Router();
  const answerQuestionFn = dependencies.answerQuestion || answerQuestion;
  const createSessionFn =
    dependencies.createSessionWithOptionalInitialAnswer ||
    createSessionWithOptionalInitialAnswer;
  const deleteSessionFn =
    dependencies.deleteViewerSession || deleteViewerSession;
  const getSessionFn = dependencies.getViewerSession || getViewerSession;
  const listSessionsFn = dependencies.listViewerSessions || listViewerSessions;
  const logger = dependencies.logger || console;
  const logRouteError = ({ event, requestId, error, fallbackCode }) => {
    try {
      logger.error(
        JSON.stringify({
          event,
          requestId: requestId || null,
          errorCode: getStableRagErrorCode(error, fallbackCode),
        }),
      );
    } catch {
      // Observability must not change request behavior.
    }
  };

  router.use((req, _res, next) => {
    if ( !req.session?.currentUser && !req.session?.ragGuest ) {
      req.session.ragGuest = createGuestSessionMetadata();
    }
    next();
  });

router.get("/sessions", async (req, res) => {
  try {
    const sessions = await listSessionsFn({
      userId: req.session?.currentUser?._id || null,
      clientSessionId: req.sessionID,
    });
    sendData(res, sessions);
  } catch ( error ) {
    logRouteError({
      event: "rag_list_failed",
      requestId: req.requestId,
      error,
      fallbackCode: "RAG_LIST_FAILED",
    });
    sendError(res, {
      code: "RAG_LIST_FAILED",
      message: "Failed to load chat sessions.",
      status: 500,
    });
  }
});

router.get("/sessions/:sessionId", async (req, res) => {
  try {
    const session = await getSessionFn({
      sessionId: req.params.sessionId,
      userId: req.session?.currentUser?._id || null,
      clientSessionId: req.sessionID,
    });
    sendData(res, session);
  } catch ( error ) {
    const status = getErrorStatus(error);
    logRouteError({
      event: "rag_get_failed",
      requestId: req.requestId,
      error,
      fallbackCode: status === 403 ? "FORBIDDEN" : "RAG_SESSION_FAILED",
    });
    if ( status === 404 ) {
      return sendNotFound(res, "Chat session not found");
    }
    sendError(res, {
      code: status === 403 ? "FORBIDDEN" : "RAG_SESSION_FAILED",
      message:
        status === 403 ? error.message : "Failed to load chat session.",
      status,
    });
  }
});

// The two calls that wait on the chat model can stream. With
// `Accept: text/event-stream` they send progress events, then a `done` event
// whose payload is the JSON response body ({ data }); a failure once the
// stream is open arrives as an `error` event with the usual { error } body and
// the status the JSON response would have had. Without that header they
// answer with JSON exactly as before.
router.post("/sessions", upload.single("file"), async (req, res) => {
  const stream = acceptsEventStream(req) ? createEventStream(res) : null;
  try {
    const { sourceText, initialQuestion: rawInitialQuestion } =
      createSessionSchema.parse(req.body);
    if ( !sourceText && !req.file ) {
      return sendError(res, {
        code: "VALIDATION_ERROR",
        message: "Provide sourceText or upload a file.",
        status: 400,
      });
    }

    if ( stream ) {
      await saveSessionBeforeStream(req);
    }
    const session = await createSessionFn({
      userId: req.session?.currentUser?._id || null,
      clientSessionId: req.sessionID,
      sourceText,
      file: req.file || null,
      initialQuestion: rawInitialQuestion,
      requestId: req.requestId,
      logger,
      onEvent: stream?.send,
    });
    if ( stream ) {
      return stream.done(session);
    }
    sendData(res, session, 201);
  } catch ( error ) {
    const status = getErrorStatus(error);
    const code = status === 400 ? "VALIDATION_ERROR" : "RAG_CREATE_FAILED";
    logRouteError({
      event: "rag_create_failed",
      requestId: req.requestId,
      error,
      fallbackCode: code,
    });
    const failure = {
      code,
      message:
        status === 400
          ? error.message
          : "Failed to start chat session.",
      status,
    };
    if ( stream?.opened ) {
      return stream.fail(failure);
    }
    sendError(res, failure);
  }
});

router.post("/sessions/:sessionId/messages", async (req, res) => {
  const stream = acceptsEventStream(req) ? createEventStream(res) : null;
  try {
    const { message } = messageSchema.parse(req.body);
    if ( stream ) {
      await saveSessionBeforeStream(req);
    }
    const result = await answerQuestionFn({
      sessionId: req.params.sessionId,
      userId: req.session?.currentUser?._id || null,
      clientSessionId: req.sessionID,
      question: message,
      requestId: req.requestId,
      onEvent: stream?.send,
    });
    if ( stream ) {
      return stream.done(result);
    }
    sendData(res, result);
  } catch ( error ) {
    const status = getErrorStatus(error);
    const code =
      status === 400
        ? "VALIDATION_ERROR"
        : status === 403
          ? "FORBIDDEN"
          : "RAG_MESSAGE_FAILED";
    logRouteError({
      event: "rag_message_failed",
      requestId: req.requestId,
      error,
      fallbackCode: code,
    });
    const failure = {
      code,
      message:
        status === 400 || status === 403
          ? error.message
          : "Failed to answer question.",
      status,
    };
    if ( stream?.opened ) {
      return stream.fail(failure);
    }
    if ( status === 404 ) {
      return sendNotFound(res, "Chat session not found");
    }
    sendError(res, failure);
  }
});

router.delete("/sessions/:sessionId", async (req, res) => {
  try {
    const result = await deleteSessionFn({
      sessionId: req.params.sessionId,
      userId: req.session?.currentUser?._id || null,
      clientSessionId: req.sessionID,
    });
    sendData(res, result);
  } catch ( error ) {
    const status = getErrorStatus(error);
    logRouteError({
      event: "rag_delete_failed",
      requestId: req.requestId,
      error,
      fallbackCode:
        status === 403
          ? "FORBIDDEN"
          : status === 503
            ? "RAG_SESSION_DELETE_RETRYABLE"
            : "RAG_SESSION_DELETE_FAILED",
    });
    if ( status === 404 ) {
      return sendNotFound(res, "Chat session not found");
    }
    sendError(res, {
      code:
        status === 403
          ? "FORBIDDEN"
          : status === 503
            ? "RAG_SESSION_DELETE_RETRYABLE"
            : "RAG_SESSION_DELETE_FAILED",
      message:
        status === 403
          ? error.message
          : status === 503
            ? "Session deletion did not complete. Retry the request."
            : "Failed to delete chat session.",
      status,
    });
  }
});

  return router;
};

const router = createRagRouter();

export default router;
