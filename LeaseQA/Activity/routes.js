import express from "express";
import * as dao from "./dao.js";
import { requireUser } from "../utils/session.js";
import { sendData, sendError } from "../utils/responses.js";

const parseLimit = (value, fallback) => {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

export const createActivityRouter = (activityDao = dao) => {
  const router = express.Router();

  router.get("/", async (req, res) => {
    const currentUser = requireUser(req, res);
    if (!currentUser) return;

    const limit = parseLimit(req.query.limit, 20);
    const items = await activityDao.listActivityForUser(currentUser._id, {
      limit,
    });
    sendData(res, items);
  });

  router.get("/notifications", async (req, res) => {
    const currentUser = requireUser(req, res);
    if (!currentUser) return;

    const limit = parseLimit(req.query.limit, 5);
    const items = await activityDao.listUnreadNotificationsForUser(
      currentUser._id,
      {
        limit,
      },
    );
    sendData(res, items);
  });

  router.post("/notifications/read", async (req, res) => {
    const currentUser = requireUser(req, res);
    if (!currentUser) return;

    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(Boolean) : [];
    if (!ids.length) {
      return sendError(res, {
        code: "VALIDATION_ERROR",
        message: "Provide at least one activity id.",
        status: 400,
      });
    }

    const result = await activityDao.markActivitiesRead(currentUser._id, ids);
    sendData(res, result);
  });

  return router;
};

export default createActivityRouter();
