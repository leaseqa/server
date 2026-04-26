import model from "./model.js";

export const createActivity = (payload) =>
  model.create({
    userId: payload.userId,
    type: payload.type,
    title: payload.title,
    summary: payload.summary || "",
    href: payload.href || "",
    surface: payload.surface || "account",
    readAt: payload.readAt || null,
    metadata: payload.metadata || {},
  });

export const listActivityForUser = (userId, { limit = 20 } = {}) =>
  model.find({ userId }).sort({ createdAt: -1 }).limit(limit);

export const listUnreadNotificationsForUser = (userId, { limit = 5 } = {}) =>
  model
    .find({
      userId,
      readAt: null,
      surface: { $in: ["notification", "both"] },
    })
    .sort({ createdAt: -1 })
    .limit(limit);

export const markActivitiesRead = async (userId, ids = []) => {
  if ( !ids.length ) {
    return { updatedCount: 0 };
  }
  const result = await model.updateMany(
    { userId, _id: { $in: ids } },
    { $set: { readAt: new Date() } },
  );
  return { updatedCount: result.modifiedCount ?? result.matchedCount ?? 0 };
};
