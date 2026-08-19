import model from "./model.js";

export const findAnswersByPostId = (postId) =>
  model.find({ postId });

export const findAnswersByPostIds = async (postIds) => {
  const grouped = new Map(postIds.map((postId) => [postId.toString(), []]));
  if ( !postIds.length ) return grouped;

  const answers = await model.find({ postId: { $in: postIds } });
  for (const answer of answers) {
    const key = answer.postId.toString();
    const bucket = grouped.get(key) || [];
    bucket.push(answer);
    grouped.set(key, bucket);
  }
  return grouped;
};

export const findAnswerById = (id) =>
  model.findById(id);

export const createAnswer = (payload) =>
  model.create({
    postId: payload.postId,
    authorId: payload.authorId,
    answerType: payload.answerType,
    content: payload.content,
    isAccepted: false,
  });

export const updateAnswer = (answerId, updates) =>
  model.findByIdAndUpdate(answerId, updates, { new: true });

export const acceptAnswer = (answerId) =>
  model.findByIdAndUpdate(answerId, { isAccepted: true }, { new: true });

export const deleteAnswer = (answerId) =>
  model.findByIdAndDelete(answerId);

export const deleteAnswersByPostId = (postId) =>
  model.deleteMany({ postId });
