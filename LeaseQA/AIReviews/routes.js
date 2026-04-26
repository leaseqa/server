import express from "express";
import multer from "multer";
import * as aiDao from "./dao.js";
import { analyzeContractText } from "./analyzer.js";
import { sendData, sendError, sendNotFound } from "../utils/responses.js";
import { requireUser } from "../utils/session.js";
import { enqueueJob } from "./jobQueue.js";

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

router.get("/", async (req, res) => {
  try {
    const currentUser = req.session?.currentUser;
    if ( !currentUser ) {
      return sendData(res, []);
    }
    const reviews = await aiDao.listReviewsForUser(currentUser._id);
    sendData(res, reviews);
  } catch ( error ) {
    console.error("[AI Reviews] Error listing reviews:", error);
    sendError(res, {
      code: "INTERNAL_ERROR",
      message: "Failed to load reviews.",
      status: 500
    });
  }
});


router.get("/:reviewId", async (req, res) => {
  const review = await aiDao.findReviewById(req.params.reviewId);
  if ( !review ) {
    return sendNotFound(res, "Review not found");
  }
  sendData(res, review);
});

router.post("/", upload.single("file"), async (req, res) => {
  const { contractText, contractType, relatedPostId } = req.body;
  const currentUser = req.session?.currentUser;

  let textContent = contractText;
  if ( !textContent && req.file ) {
    textContent = req.file.buffer.toString("utf-8");
  }

  if ( !textContent ) {
    return sendError(res, {
      code: "VALIDATION_ERROR",
      message: "Provide contractText or upload a file.",
      status: 400,
    });
  }

  try {
    const review = await aiDao.createReview({
      userId: currentUser?._id || null,
      contractType,
      relatedPostId,
      contractText: textContent,
      status: "pending",
      aiResponse: null,
      error: null,
      startedAt: null,
      completedAt: null,
    });

    // Process asynchronously to avoid tying up the request on high-latency model calls.
    enqueueJob(async () => {
      try {
        await aiDao.updateReview(review._id, {
          status: "processing",
          startedAt: new Date(),
          error: null,
        });

        const aiResponse = await analyzeContractText(textContent);
        await aiDao.updateReview(review._id, {
          status: "completed",
          aiResponse,
          completedAt: new Date(),
          error: null,
        });
      } catch ( err ) {
        console.error("[AI Reviews] Async analysis failed:", err);
        await aiDao.updateReview(review._id, {
          status: "failed",
          error: err?.message || "AI review failed",
          completedAt: new Date(),
        });
      }
    });

    // 202 Accepted: review created, analysis running in background.
    sendData(res, review, 202);
  } catch ( err ) {
    console.error("AI review failed", err);
    sendError(res, {
      code: "AI_REVIEW_ERROR",
      message: err.message || "AI review failed",
      details: `Node: ${process.version} - ${err.toString()}`,
      status: 500,
    });
  }
});

router.delete("/:reviewId", async (req, res) => {
  const currentUser = requireUser(req, res);
  if ( !currentUser ) return;

  const review = await aiDao.findReviewById(req.params.reviewId);
  if ( !review ) {
    return sendNotFound(res, "Review not found");
  }

  if ( review.userId?.toString() !== currentUser._id.toString() && currentUser.role !== "admin" ) {
    return sendError(res, {
      code: "FORBIDDEN",
      message: "You can only delete your own reviews.",
      status: 403,
    });
  }

  await aiDao.deleteReview(req.params.reviewId);
  sendData(res, { message: "Review deleted" });
});

export default router;
