import express from "express";
import * as answersDao from "./dao.js";
import * as postsDao from "../Posts/dao.js";
import {requireUser} from "../utils/session.js";
import {sendData, sendError, sendNotFound} from "../utils/responses.js";
import { createActivity } from "../Activity/dao.js";
import { buildActivity } from "../Activity/service.js";

const recordAnswerActivity = async ({
    recordActivityFn,
    post,
    answer,
    actorId,
}) => {
    const recipientId = post?.authorId?.toString?.() || post?.authorId;
    if (!recipientId || recipientId === actorId?.toString?.()) {
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
    } catch (error) {
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
        if (!currentUser) return;

        const {postId, content, answerType} = req.body;
        if (!postId || !content || !answerType) {
            return sendError(res, {
                code: "VALIDATION_ERROR",
                message: "postId, content, and answerType are required.",
                status: 400,
            });
        }

        if (answerType === "lawyer_opinion" && currentUser.role !== "lawyer") {
            return sendError(res, {
                code: "FORBIDDEN",
                message: "Only verified lawyers can publish lawyer opinions.",
                status: 403,
            });
        }

        const post = await postsDaoImpl.findPostById(postId);
        if (!post) {
            return sendNotFound(res, "Post not found");
        }

        const answer = await answersDaoImpl.createAnswer({
            postId,
            content,
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
        if (!currentUser) return;

        const answer = await answersDaoImpl.findAnswerById(req.params.answerId);
        if (!answer) {
            return sendNotFound(res, "Answer not found");
        }

        if (answer.authorId.toString() !== currentUser._id.toString() && currentUser.role !== "admin") {
            return sendError(res, {
                code: "FORBIDDEN",
                message: "Only the author or admin can edit this answer.",
                status: 403,
            });
        }

        const updated = await answersDaoImpl.updateAnswer(answer._id, req.body);
        sendData(res, updated);
    });

    router.delete("/:answerId", async (req, res) => {
        const currentUser = requireUser(req, res);
        if (!currentUser) return;

        const answer = await answersDaoImpl.findAnswerById(req.params.answerId);
        if (!answer) {
            return sendNotFound(res, "Answer not found");
        }

        if (currentUser.role !== "admin" && answer.authorId.toString() !== currentUser._id.toString()) {
            return sendError(res, {
                code: "FORBIDDEN",
                message: "Only the author or admin can delete this answer.",
                status: 403,
            });
        }

        await answersDaoImpl.deleteAnswer(answer._id);
        sendData(res, {message: "Answer deleted"});
    });

    router.post("/:answerId/accept", async (req, res) => {
        const currentUser = requireUser(req, res);
        if (!currentUser) return;

        const answer = await answersDaoImpl.findAnswerById(req.params.answerId);
        if (!answer) {
            return sendNotFound(res, "Answer not found");
        }

        const post = await postsDaoImpl.findPostById(answer.postId);
        if (!post) {
            return sendNotFound(res, "Post not found");
        }

        if (post.authorId.toString() !== currentUser._id.toString() && currentUser.role !== "admin") {
            return sendError(res, {
                code: "FORBIDDEN",
                message: "Only the post author or admin can mark an answer as accepted.",
                status: 403,
            });
        }

        const updatedAnswer = await answersDaoImpl.updateAnswer(answer._id, {isAccepted: true});
        await postsDaoImpl.updatePost(post._id, {isResolved: true});
        sendData(res, updatedAnswer);
    });

    return router;
};

export default createAnswersRouter();
