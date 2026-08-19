import express from "express";
import * as answersDao from "./dao.js";
import * as postsDao from "../Posts/dao.js";
import { requireUser } from "../utils/session.js";
import { sendData, sendError, sendNotFound } from "../utils/responses.js";
import { createActivity } from "../Activity/dao.js";
import { buildActivity } from "../Activity/service.js";
import { sanitizeRichText } from "../utils/richText.js";

const isVerifiedLawyer = (user) =>
  user?.role === "lawyer" &&
  user.lawyerVerification?.verifiedAt &&
  !Number.isNaN(new Date(user.lawyerVerification.verifiedAt).getTime());

const sendLawyerOpinionForbidden = (res) => sendError(res, {
  code: "FORBIDDEN",
  message: "Only verified lawyers can publish lawyer opinions.",
  status: 403,
});

const recordAnswerActivity = async ({
                                      recordActivityFn,
                                      post,
                                      answer,
                                      actorId,
                                    }) => {
  const recipientId = post?.authorId?.toString?.() || post?.authorId;
  if ( !recipientId || recipientId === actorId?.toString?.() ) {
    return;
  }
  try {
    await recordActivityFn(
      buildActivity({
        userId: recipientId,
        type: "answer_received",
        title: "New answer on your question",
        summary: post.summary || "Someone answered your post",
        href: `/qa?post=${post._id.toString?.() || post._id}`,
        surface: "both",
        metadata: {
          postId: post._id.toString?.() || post._id,
          answerId: answer._id?.toString?.() || answer._id,
          actorId: actorId?.toString?.() || actorId,
        },
      }),
    );
  } catch ( error ) {
    console.error("[Answers] Failed to record answer activity:", error);
  }
};

export const createAnswersRouter = ({
                                      answersDao: answersDaoImpl = answersDao,
                                      postsDao: postsDaoImpl = postsDao,
                                      recordActivityFn = createActivity,
                                    } = {}) => {
  const router = express.Router();

  router.post("/", async (req, res) => {
    const currentUser = requireUser(req, res);
    if ( !currentUser ) return;

    const { postId, content, answerType } = req.body;
    if ( !postId || !content || !answerType ) {
      return sendError(res, {
        code: "VALIDATION_ERROR",
        message: "postId, content, and answerType are required.",
        status: 400,
      });
    }

    if (
      answerType === "lawyer_opinion" &&
      !isVerifiedLawyer(currentUser)
    ) {
      return sendLawyerOpinionForbidden(res);
    }

    const post = await postsDaoImpl.findPostById(postId);
    if ( !post ) {
      return sendNotFound(res, "Post not found");
    }

    const answer = await answersDaoImpl.createAnswer({
      postId,
      content: sanitizeRichText(content),
      answerType,
      authorId: currentUser._id,
    });
    await recordAnswerActivity({
      recordActivityFn,
      post,
      answer,
      actorId: currentUser._id,
    });
    sendData(res, answer, 201);
  });

  router.put("/:answerId", async (req, res) => {
    const currentUser = requireUser(req, res);
    if ( !currentUser ) return;

    const answer = await answersDaoImpl.findAnswerById(req.params.answerId);
    if ( !answer ) {
      return sendNotFound(res, "Answer not found");
    }

    if ( answer.authorId.toString() !== currentUser._id.toString() && currentUser.role !== "admin" ) {
      return sendError(res, {
        code: "FORBIDDEN",
        message: "Only the author or admin can edit this answer.",
        status: 403,
      });
    }

    if ( req.body.answerType === "lawyer_opinion" && !isVerifiedLawyer(currentUser) ) {
      return sendLawyerOpinionForbidden(res);
    }

    const updates = {
      ...req.body,
      ...(typeof req.body.content === "string"
        ? { content: sanitizeRichText(req.body.content) }
        : {}),
    };
    const updated = await answersDaoImpl.updateAnswer(answer._id, updates);
    sendData(res, updated);
  });

  router.delete("/:answerId", async (req, res) => {
    const currentUser = requireUser(req, res);
    if ( !currentUser ) return;

    const answer = await answersDaoImpl.findAnswerById(req.params.answerId);
    if ( !answer ) {
      return sendNotFound(res, "Answer not found");
    }

    if ( currentUser.role !== "admin" && answer.authorId.toString() !== currentUser._id.toString() ) {
      return sendError(res, {
        code: "FORBIDDEN",
        message: "Only the author or admin can delete this answer.",
        status: 403,
      });
    }

    await answersDaoImpl.deleteAnswer(answer._id);
    sendData(res, { message: "Answer deleted" });
  });

  router.post("/:answerId/accept", async (req, res) => {
    const currentUser = requireUser(req, res);
    if ( !currentUser ) return;

    const answer = await answersDaoImpl.findAnswerById(req.params.answerId);
    if ( !answer ) {
      return sendNotFound(res, "Answer not found");
    }

    const post = await postsDaoImpl.findPostById(answer.postId);
    if ( !post ) {
      return sendNotFound(res, "Post not found");
    }

    if ( post.authorId.toString() !== currentUser._id.toString() && currentUser.role !== "admin" ) {
      return sendError(res, {
        code: "FORBIDDEN",
        message: "Only the post author or admin can mark an answer as accepted.",
        status: 403,
      });
    }

    const updatedAnswer = await answersDaoImpl.updateAnswer(answer._id, { isAccepted: true });
    await postsDaoImpl.updatePost(post._id, { isResolved: true });
    sendData(res, updatedAnswer);
  });

  return router;
};

export default createAnswersRouter();
