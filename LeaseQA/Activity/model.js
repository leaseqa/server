import mongoose from "mongoose";
import schema from "./schema.js";

const model = mongoose.models.ActivityModel || mongoose.model("ActivityModel", schema);
export default model;
