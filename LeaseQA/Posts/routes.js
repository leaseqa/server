import express from "express";
import * as postsDao from "./dao.js";
import * as answersDao from "../Answers/dao.js";
import * as discussionsDao from "../Discussions/dao.js";
import { annotateDiscussionTreeAuthors, collectDiscussionAuthorIds, } from "../Discussions/tree.js";
import * as usersDao from "../Users/dao.js";
import { requireRole, requireUser } from "../utils/session.js";
import { sendData, sendError, sendNotFound } from "../utils/responses.js";
import { createActivity } from "../Activity/dao.js";
import { buildActivity } from "../Activity/service.js";
import { sanitizeRichText } from "../utils/richText.js";
import { createAttachmentUpload } from "./uploadPolicy.js";

export const attachmentUpload = createAttachmentUpload(process.env);

const buildUserMap = async (ids = [], usersDaoImpl = usersDao) => {
  const uniqueIds = [...new Set(ids.filter(Boolean).map((id) => id.toString()))];
  if ( !uniqueIds.length ) return {};
  const users = await usersDaoImpl.findUsersByIds(uniqueIds);
  const map = {};
  users.forEach((u) => {
    map[u._id.toString()] = usersDaoImpl.sanitizeUser(u);
  });
  return map;
};

const recordPostCreatedActivity = async ({ recordActivityFn, post, actorId }) => {
  try {
    await recordActivityFn(
      buildActivity({
        userId: actorId?.toString?.() || actorId,
        type: "post_created",
        title: "Posted a new question",
        summary: post.summary || "New community post",
        href: `/qa?post=${post._id?.toString?.() || post._id}`,
        surface: "account",
        metadata: {
          postId: post._id?.toString?.() || post._id,
        },
      }),
    );
  } catch ( error ) {
    console.error("[Posts] Failed to record post-created activity:", error);
  }
};

const recordPostStatusActivity = async ({
                                          recordActivityFn,
                                          previousPost,
                                          updatedPost,
                                          actorId,
                                        }) => {
  const statusChanged =
    previousPost.isResolved !== updatedPost.isResolved ||
    previousPost.isPinned !== updatedPost.isPinned;
  const recipientId =
    updatedPost.authorId?.toString?.() || updatedPost.authorId;
  const actor = actorId?.toString?.() || actorId;
  if ( !statusChanged || !recipientId || recipientId === actor ) {
    return;
  }
  try {
    await recordActivityFn(
      buildActivity({
        userId: recipientId,
        type: "post_status_changed",
        title: "Your post status changed",
        summary: updatedPost.summary || "A moderator updated your post",
        href: `/qa?post=${updatedPost._id?.toString?.() || updatedPost._id}`,
        surface: "both",
        metadata: {
          postId: updatedPost._id?.toString?.() || updatedPost._id,
          isResolved: updatedPost.isResolved === true,
          isPinned: updatedPost.isPinned === true,
          actorId: actor,
        },
      }),
    );
  } catch ( error ) {
    console.error("[Posts] Failed to record post-status activity:", error);
  }
};

export const createPostsRouter = ({
                                    postsDao: postsDaoImpl = postsDao,
                                    answersDao: answersDaoImpl = answersDao,
                                    discussionsDao: discussionsDaoImpl = discussionsDao,
                                    usersDao: usersDaoImpl = usersDao,
                                    buildUserMapFn,
                                    recordActivityFn = createActivity,
                                    attachmentUpload: attachmentUploadImpl = attachmentUpload,
                                  } = {}) => {
  const router = express.Router();
  const loadUserMap = buildUserMapFn || ((ids) => buildUserMap(ids, usersDaoImpl));
  const uploadFiles = attachmentUploadImpl.enabled
    ? attachmentUploadImpl.array("files", 5)
    : null;
  const receiveAttachments = (req, res, next) => {
    if ( !uploadFiles ) {
      return sendError(res, {
        code: "UPLOADS_DISABLED",
        message: "Attachment uploads are disabled.",
        status: 503,
      });
    }
    uploadFiles(req, res, (error) => {
      if ( !error ) {
        next();
        return;
      }
      sendError(res, {
        code: error.code || "UPLOAD_REJECTED",
        message: "Attachment upload rejected.",
        status: 400,
      });
    });
  };
  const authorizeAttachmentUpload = async (req, res, next) => {
    const currentUser = requireUser(req, res);
    if ( !currentUser ) return;

    const post = await postsDaoImpl.findPostById(req.params.postId);
    if ( !post ) {
      return sendNotFound(res, "Post not found");
    }

    if ( post.authorId.toString() !== currentUser._id.toString() && currentUser.role !== "admin" ) {
      return sendError(res, {
        code: "FORBIDDEN",
        message: "Only the author or admin can add attachments.",
        status: 403,
      });
    }

    req.attachmentPost = post;
    next();
  };

  router.get("/", async (req, res) => {
    const filters = {
      folder: req.query.folder,
      search: req.query.search,
      role: req.query.role,
      viewerRole: req.session?.currentUser?.role,
      audience: req.query.audience,
    };

    const posts = await postsDaoImpl.listPosts(filters);

    if ( !posts.length ) {
      return sendData(res, []);
    }

    const postIds = posts.map((post) => post._id);
    const [answersByPost, discussionsByPost] = await Promise.all([
      answersDaoImpl.findAnswersByPostIds(postIds),
      discussionsDaoImpl.findDiscussionTreesByPostIds(postIds),
    ]);
    const allAuthorIds = [];
    for (const post of posts) {
      const key = post._id.toString();
      const answers = answersByPost.get(key) || [];
      const discussions = discussionsByPost.get(key) || [];
      allAuthorIds.push(
        post.authorId,
        ...answers.map((answer) => answer.authorId),
        ...collectDiscussionAuthorIds(discussions),
      );
    }
    const userMap = await loadUserMap(allAuthorIds);

    const data = posts.map((post) => {
        const key = post._id.toString();
        const answers = answersByPost.get(key) || [];
        const discussions = discussionsByPost.get(key) || [];
        const withAuthor = (item) => {
          const obj = item.toObject ? item.toObject() : item;
          return { ...obj, author: userMap[obj.authorId?.toString()] || null };
        };

        return {
          ...post.toObject(),
          author: userMap[post.authorId?.toString()] || null,
          answers: answers.map(withAuthor),
          discussions: annotateDiscussionTreeAuthors(discussions, userMap),
        };
      });

    sendData(res, data);
  });

  router.get("/:postId", async (req, res) => {
    const post = await postsDaoImpl.findPostById(req.params.postId);
    if ( !post ) {
      return sendNotFound(res, "Post not found");
    }
    if ( post.isHidden === true && req.session?.currentUser?.role !== "admin" ) {
      return sendNotFound(res, "Post not found");
    }

    await postsDaoImpl.incrementViewCount(post._id);

    const answers = await answersDaoImpl.findAnswersByPostId(post._id);
    const discussions = await discussionsDaoImpl.findDiscussionTreeForPost(post._id);

    const ids = [
      post.authorId,
      ...answers.map((a) => a.authorId),
      ...collectDiscussionAuthorIds(discussions),
    ];
    const userMap = await loadUserMap(ids);
    const withAuthor = (item) => {
      const obj = item.toObject ? item.toObject() : item;
      return { ...obj, author: userMap[obj.authorId?.toString()] || null };
    };

    sendData(res, {
      ...post.toObject(),
      author: userMap[post.authorId?.toString()] || null,
      answers: answers.map(withAuthor),
      discussions: annotateDiscussionTreeAuthors(discussions, userMap),
    });
  });

  router.post("/", async (req, res) => {
    const currentUser = requireUser(req, res);
    if ( !currentUser ) return;

    const { summary, details, folders } = req.body;
    if ( !summary || !details || !Array.isArray(folders) || folders.length === 0 ) {
      return sendError(res, {
        code: "VALIDATION_ERROR",
        message: "Summary, details, and at least one folder are required.",
        status: 400,
      });
    }

    const post = await postsDaoImpl.createPost({
      ...req.body,
      details: sanitizeRichText(details),
      authorId: currentUser._id,
    });
    await recordPostCreatedActivity({
      recordActivityFn,
      post,
      actorId: currentUser._id,
    });
    sendData(res, post, 201);
  });

  router.put("/:postId", async (req, res) => {
    try {
      const currentUser = requireUser(req, res);
      if ( !currentUser ) return;

      const post = await postsDaoImpl.findPostById(req.params.postId);
      if ( !post ) {
        return sendNotFound(res, "Post not found");
      }

      const isAuthor = post.authorId && currentUser._id &&
        post.authorId.toString() === currentUser._id.toString();
      const isAdmin = currentUser.role === "admin";

      if ( !isAuthor && !isAdmin ) {
        return sendError(res, {
          code: "FORBIDDEN",
          message: "Only the author or admin can edit this post.",
          status: 403,
        });
      }

      const updates = {
        ...req.body,
        ...(typeof req.body.details === "string"
          ? { details: sanitizeRichText(req.body.details) }
          : {}),
      };
      const updated = await postsDaoImpl.updatePost(req.params.postId, updates);
      await recordPostStatusActivity({
        recordActivityFn,
        previousPost: post,
        updatedPost: updated,
        actorId: currentUser._id,
      });
      sendData(res, updated);
    } catch ( err ) {
      console.error("Error updating post:", err);
      sendError(res, {
        code: "SERVER_ERROR",
        message: err.message || "Failed to update post",
        status: 500,
      });
    }
  });

  router.delete("/:postId", async (req, res) => {
    const currentUser = requireRole(req, res, ["admin"]);
    if ( !currentUser ) return;

    const post = await postsDaoImpl.findPostById(req.params.postId);
    if ( !post ) {
      return sendNotFound(res, "Post not found");
    }

    await answersDaoImpl.deleteAnswersByPostId(post._id);
    await discussionsDaoImpl.deleteDiscussionsByPostId(post._id);
    await postsDaoImpl.deletePost(post._id);

    sendData(res, { message: "Post deleted" });
  });

  router.patch("/:postId/pin", async (req, res) => {
    const currentUser = requireRole(req, res, ["admin"]);
    if ( !currentUser ) return;

    const post = await postsDaoImpl.findPostById(req.params.postId);
    if ( !post ) {
      return sendNotFound(res, "Post not found");
    }

    const isPinned = req.body.isPinned !== undefined ? req.body.isPinned : !post.isPinned;
    const updated = await postsDaoImpl.updatePost(req.params.postId, { isPinned });
    await recordPostStatusActivity({
      recordActivityFn,
      previousPost: post,
      updatedPost: updated,
      actorId: currentUser._id,
    });
    sendData(res, updated);
  });

  router.post("/:postId/attachments", authorizeAttachmentUpload, receiveAttachments, async (req, res) => {
    const post = req.attachmentPost;
    const files = req.files || [];
    if ( !files.length ) {
      return sendError(res, { code: "VALIDATION_ERROR", message: "No files uploaded", status: 400 });
    }

    const baseUrl = process.env.SERVER_URL || `http://localhost:${process.env.PORT || 4000}`;
    const newAttachments = files.map((file) => ({
      filename: file.originalname,
      url: `${baseUrl}/uploads/${file.filename}`,
      mimetype: file.mimetype,
      size: file.size,
      uploadedAt: new Date(),
    }));

    post.attachments = [...(post.attachments || []), ...newAttachments];
    await post.save();

    sendData(res, post);
  });

  return router;
};

export default createPostsRouter();
