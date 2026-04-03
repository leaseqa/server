import "dotenv/config";
import mongoose from "mongoose";
import ragModel from "../LeaseQA/RAG/model.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [rawKey, ...rest] = arg.replace(/^--/, "").split("=");
    return [rawKey, rest.join("=")];
  }),
);

const mongoUrl = process.env.DATABASE_CONNECTION_STRING;

if (!mongoUrl) {
  console.error("DATABASE_CONNECTION_STRING is required");
  process.exit(1);
}

const query = {};

if (args.participant) {
  query.studyParticipantId = args.participant;
}

if (args.condition) {
  query.studyConditionId = args.condition;
}

if (args.source) {
  query.studyParticipantSource = args.source;
}

if (args.since || args.until) {
  query.createdAt = {};
  if (args.since) {
    query.createdAt.$gte = new Date(args.since);
  }
  if (args.until) {
    query.createdAt.$lte = new Date(args.until);
  }
}

const limit = Number.parseInt(args.limit || "20", 10);

const renderTranscript = (messages) =>
  messages.map((message) => ({
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  }));

try {
  await mongoose.connect(mongoUrl);

  const sessions = await ragModel
    .find(query)
    .sort({ createdAt: -1 })
    .limit(Number.isFinite(limit) ? limit : 20)
    .lean();

  const output = sessions.map((session) => ({
    sessionId: session._id,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    sourceKind: session.sourceKind,
    sourceName: session.sourceName,
    status: session.status,
    studyParticipantId: session.studyParticipantId,
    studyParticipantSource: session.studyParticipantSource,
    studyConditionId: session.studyConditionId,
    studyScenarioId: session.studyScenarioId,
    studyFraming: session.studyFraming,
    messageCount: session.messages.length,
    transcript: renderTranscript(session.messages),
  }));

  console.log(JSON.stringify(output, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect().catch(() => {});
}
