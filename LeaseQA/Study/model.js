import mongoose from "mongoose";
import schema from "./schema.js";

const model = mongoose.model("StudySession", schema);

export default model;

