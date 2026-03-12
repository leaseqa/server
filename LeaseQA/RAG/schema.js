import mongoose, { Types } from "mongoose";

const citationSchema = new mongoose.Schema(
  {
    sourceName: { type: String, required: true },
    sourceGroup: { type: String, required: true },
    sourceType: { type: String, required: true },
    chapterRef: { type: String, default: null },
    filePath: { type: String, default: null },
    sourceUrl: { type: String, default: null },
    snippet: { type: String, required: true },
  },
  { _id: false },
);

const answerBulletSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    citationIndices: { type: [Number], default: [] },
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ["user", "assistant"],
      required: true,
    },
    content: { type: String, required: true },
    summary: { type: String, default: null },
    bullets: { type: [answerBulletSchema], default: undefined },
    citations: { type: [citationSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ragSessionSchema = new mongoose.Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", default: null, index: true },
    clientSessionId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["indexing", "ready", "failed"],
      default: "indexing",
      index: true,
    },
    error: { type: String, default: null },
    sourceKind: {
      type: String,
      enum: ["upload", "text"],
      required: true,
    },
    sourceName: { type: String, required: true },
    sourceMimeType: { type: String, default: null },
    sourceTextPreview: { type: String, required: true },
    sourceCharCount: { type: Number, required: true },
    messages: { type: [messageSchema], default: [] },
  },
  {
    timestamps: true,
    collection: "ragSessions",
  },
);

export default ragSessionSchema;
