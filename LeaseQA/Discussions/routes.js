import express from "express";
import * as discussionsDao from "./dao.js";
import * as postsDao from "../Posts/dao.js";
import { requireUser } from "../utils/session.js";
import { sendData, sendError, sendNotFound } from "../utils/responses.js";
import { createActivity } from "../Activity/dao.js";
import { buildActivity } from "../Activity/service.js";

const resolveDiscussionRecipient = ({
                                      actorId,
                                      post,
                                      parentDiscussion,
                                    }) => {
  const actor = actorId?.toString?.() || actorId;
  const parentAuthor = parentDiscussion?.authorId?.toString?.() || parentDiscussion?.authorId;
  if ( parentAuthor && parentAuthor !== actor ) {
    return parentAuthor;
  }
  const postAuthor = post?.authorId?.toString?.() || post?.authorId;
  if ( postAuthor && postAuthor !== actor ) {
    return postAuthor;
  }
  return null;
};

const recordDiscussionActivity = async ({
                                          recordActivityFn,
                                          recipientId,
                                          post,
                                          reply,
                                          parentId,
                                          actorId,
                                        }) => {
  if ( !recipientId ) {
    return;
  }
  try {
    await recordActivityFn(
      buildActivity({
        userId: recipientId,
        type: "discussion_received",
        title: "New follow-up on your thread",
        summary: post.summary || "Someone replied to your discussion",
        href: `/qa?post=${post._id.toString?.() || post._id}`,
        surface: "both",
        metadata: {
          postId: post._id.toString?.() || post._id,
          discussionId: reply._id?.toString?.() || reply._id,
          parentId: parentId || null,
          actorId: actorId?.toString?.() || actorId,
        },
      }),
    );
  } catch ( error ) {
    console.error("[Discussions] Failed to record discussion activity:", error);
  }
};

export const createDiscussionsRouter = ({
                                          discussionsDao: discussionsDaoImpl = discussionsDao,
                                          postsDao: postsDaoImpl = postsDao,
                                          recordActivityFn = createActivity,
                                        } = {}) => {
  const router = express.Router();

  router.post("/", async (req, res) => {
    const currentUser = requireUser(req, res);
    if ( !currentUser ) return;

    const { postId, parentId, content } = req.body || {};
    if ( !postId || !content ) {
      return sendError(res, {
        code: "VALIDATION_ERROR",
        message: "postId and content are required.",
        status: 400,
      });
    }

    const post = await postsDaoImpl.findPostById(postId);
    if ( !post ) {
      return sendNotFound(res, "Post not found");
    }

    let parentDiscussion = null;
    if ( parentId ) {
      parentDiscussion = await discussionsDaoImpl.findDiscussionById(parentId);
      if ( !parentDiscussion ) {
        return sendNotFound(res, "Parent discussion not found");
      }
    }

    const reply = await discussionsDaoImpl.createDiscussion({
      postId,
      parentId,
      content,
      authorId: currentUser._id,
    });
    await recordDiscussionActivity({
      recordActivityFn,
      recipientId: resolveDiscussionRecipient({
        actorId: currentUser._id,
        post,
        parentDiscussion,
      }),
      post,
      reply,
      parentId,
      actorId: currentUser._id,
    });
    sendData(res, reply, 201);
  });

  router.patch("/:discussionId", async (req, res) => {
    const currentUser = requireUser(req, res);
    if ( !currentUser ) return;

    const discussion = await discussionsDaoImpl.findDiscussionById(req.params.discussionId);
    if ( !discussion ) {
      return sendNotFound(res, "Discussion not found");
    }

    if ( discussion.authorId.toString() !== currentUser._id.toString() && currentUser.role !== "admin" ) {
      return sendError(res, {
        code: "FORBIDDEN",
        message: "Only the author or admin can edit this discussion.",
        status: 403,
      });
    }

    const updated = await discussionsDaoImpl.updateDiscussion(discussion._id, req.body);
    sendData(res, updated);
  });

  router.patch("/:discussionId/resolve", async (req, res) => {
    const currentUser = requireUser(req, res);
    if ( !currentUser ) return;

    const discussion = await discussionsDaoImpl.findDiscussionById(req.params.discussionId);
    if ( !discussion ) {
      return sendNotFound(res, "Discussion not found");
    }

    const post = await postsDaoImpl.findPostById(discussion.postId);
    if ( !post ) {
      return sendNotFound(res, "Post not found");
    }

    if (
      post.authorId.toString() !== currentUser._id.toString() &&
      currentUser.role !== "admin" &&
      currentUser.role !== "lawyer"
    ) {
      return sendError(res, {
        code: "FORBIDDEN",
        message: "Only the post author, lawyers, or admins can toggle resolution.",
        status: 403,
      });
    }

    const updated = await discussionsDaoImpl.updateDiscussion(discussion._id, {
      isResolved: req.body.isResolved === true,
    });
    sendData(res, updated);
  });

  router.delete("/:discussionId", async (req, res) => {
    const currentUser = requireUser(req, res);
    if ( !currentUser ) return;

    const discussion = await discussionsDaoImpl.findDiscussionById(req.params.discussionId);
    if ( !discussion ) {
      return sendNotFound(res, "Discussion not found");
    }

    if ( discussion.authorId.toString() !== currentUser._id.toString() && currentUser.role !== "admin" ) {
      return sendError(res, {
        code: "FORBIDDEN",
        message: "Only the author or admin can delete this discussion.",
        status: 403,
      });
    }

    await discussionsDaoImpl.deleteDiscussionSubtree(discussion._id);
    sendData(res, { message: "Discussion deleted" });
  });

  return router;
};

export default createDiscussionsRouter();
