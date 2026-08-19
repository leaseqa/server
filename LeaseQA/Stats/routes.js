import express from "express";
import * as statsDao from "./dao.js";
import { sendData } from "../utils/responses.js";
import { requireRole } from "../utils/session.js";

const router = express.Router();

router.get("/overview", async (req, res) => {
  const admin = requireRole(req, res, ["admin"]);
  if ( !admin ) return;

  const stats = await statsDao.overview();
  sendData(res, stats);
});

export default router;
