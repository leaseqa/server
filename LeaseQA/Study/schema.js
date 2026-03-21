import mongoose from "mongoose";

const StudySessionSchema = new mongoose.Schema(
  {
    participantId: { type: String, required: true, index: true },
    scenarioId: { type: String, required: true, index: true },
    conditionId: { type: String, required: true },
    boundaryCue: {
      type: String,
      required: true,
      enum: ["low", "high"],
    },
    framing: {
      type: String,
      required: true,
      enum: ["professional_personalized", "informational_detached"],
    },
    ragSessionId: { type: String, default: null, index: true },
    turnCount: { type: Number, default: 0 },
    status: {
      type: String,
      required: true,
      enum: ["active", "completed"],
      default: "active",
    },
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "studySessions",
  },
);

StudySessionSchema.index({ participantId: 1, scenarioId: 1, status: 1 });

export default StudySessionSchema;

