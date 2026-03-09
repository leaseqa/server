import mongoose from "mongoose";
import schema from "./schema.js";

const model = mongoose.model("RAGSessionsModel", schema);
export default model;
