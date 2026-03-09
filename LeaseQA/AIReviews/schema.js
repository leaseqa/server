import mongoose, {Types} from "mongoose";

const aiReviewSchema = new mongoose.Schema(
    {
        userId: {type: Types.ObjectId, ref: "User", required: false, index: true},
        contractType: {type: String},
        contractText: {type: String, required: true},
        contractFileUrl: {type: String},
        // Async job state for high-latency AI calls.
        status: {
            type: String,
            enum: ["pending", "processing", "completed", "failed"],
            default: "completed",
            index: true,
        },
        error: {type: String},
        startedAt: {type: Date},
        completedAt: {type: Date},
        // Optional because async jobs are created in `pending` state before analysis completes.
        aiResponse: {
            summary: {type: String},
            highRisk: {type: [String], default: []},
            mediumRisk: {type: [String], default: []},
            lowRisk: {type: [String], default: []},
            recommendations: {type: [String], default: []},
        },
        relatedPostId: {type: Types.ObjectId, ref: "Post"},
    },
    {
        timestamps: true,
        collection: "aiReviews"
    }
);

export default aiReviewSchema;
