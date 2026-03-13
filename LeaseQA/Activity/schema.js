import mongoose, { Types } from "mongoose";

const ActivitySchema = new mongoose.Schema(
  {
    userId: { type: Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    summary: { type: String, default: "" },
    href: { type: String, default: "" },
    surface: {
      type: String,
      enum: ["account", "notification", "both"],
      default: "account",
    },
    readAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    collection: "activities",
  },
);

ActivitySchema.index({ userId: 1, createdAt: -1 });
ActivitySchema.index({ userId: 1, surface: 1, readAt: 1, createdAt: -1 });

export default ActivitySchema;
