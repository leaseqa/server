import express from "express";
import { rateLimit } from "express-rate-limit";
import passport from "passport";

import authRoutes from "./Auth/routes.js";
import userRoutes from "./Users/routes.js";
import ragRoutes from "./RAG/routes.js";
import postRoutes, { attachmentUpload as defaultAttachmentUpload } from "./Posts/routes.js";
import { RAG_READ_LIMIT, RAG_WRITE_LIMIT, isRagRead } from "./shared/rateLimits.js";
import answerRoutes from "./Answers/routes.js";
import discussionRoutes from "./Discussions/routes.js";
import folderRoutes from "./Folders/routes.js";
import statsRoutes from "./Stats/routes.js";
import moderationRoutes from "./Moderation/routes.js";
import activityRoutes from "./Activity/routes.js";
import { scrubBlockedDemoSession } from "./utils/session.js";
import { applyHttpSecurity, unexpectedErrorHandler } from "./utils/httpSecurity.js";

const noSessionStore = (req, _res, next) => {
  req.session = req.session || {};
  next();
};

export const createApplication = ({
  env = process.env,
  sessionMiddleware = noSessionStore,
  attachmentUpload = defaultAttachmentUpload,
} = {}) => {
  const app = express();
  applyHttpSecurity(app, env);

  app.use(sessionMiddleware);
  app.use((req, _res, next) => {
    scrubBlockedDemoSession(req, { env });
    next();
  });
  app.use(passport.initialize());
  app.use(express.json());

  if ( attachmentUpload.enabled ) {
    app.use("/uploads", attachmentUpload.serve);
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  const isTest = env.CI_DISABLE_RATE_LIMIT === "true";
  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: isTest ? 1000 : 10 });
  // Polling reads and paid generation get separate budgets; see rateLimits.js.
  const ragReadLimiter = rateLimit({
    ...RAG_READ_LIMIT,
    max: isTest ? 10000 : RAG_READ_LIMIT.max,
    skip: (req) => !isRagRead(req.method),
  });
  const ragWriteLimiter = rateLimit({
    ...RAG_WRITE_LIMIT,
    max: isTest ? 10000 : RAG_WRITE_LIMIT.max,
    skip: (req) => isRagRead(req.method),
  });
  const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: isTest ? 10000 : 100 });

  app.use("/api", generalLimiter);
  app.use("/api/auth", authLimiter);
  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/rag", ragReadLimiter, ragWriteLimiter, ragRoutes);
  app.use("/api/posts", postRoutes);
  app.use("/api/answers", answerRoutes);
  app.use("/api/discussions", discussionRoutes);
  app.use("/api/folders", folderRoutes);
  app.use("/api/stats", statsRoutes);
  app.use("/api/moderation", moderationRoutes);
  app.use("/api/activity", activityRoutes);
  app.use(unexpectedErrorHandler);

  return app;
};
