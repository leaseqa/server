import express from "express";
import * as postsDao from "../Posts/dao.js";
import { requireRole } from "../utils/session.js";
import { sendData, sendNotFound } from "../utils/responses.js";

const router = express.Router();

router.post("/posts/:postId/hide", async (req, res) => {
  const admin = requireRole(req, res, ["admin"]);
  if ( !admin ) {
    return;
  }
  const updated = await postsDao.updatePost(req.params.postId, {
    isHidden: req.body.isHidden !== false,
  });
  if ( !updated ) {
    return sendNotFound(res, "Post not found");
  }
  sendData(res, updated);
});

export default router;
