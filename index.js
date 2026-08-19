import "dotenv/config";
import session from "express-session";
import MongoStore from "connect-mongo";
import mongoose from "mongoose";

import { createApplication } from "./LeaseQA/app.js";
import { assertProductionSessionConfig } from "./LeaseQA/utils/httpSecurity.js";

const isProdLikeEnv =
  process.env.SERVER_ENV && process.env.SERVER_ENV !== "development";
const sessionSecret = assertProductionSessionConfig(process.env);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.DATABASE_CONNECTION_STRING);
    console.log("Connected to MongoDB");
  } catch ( error ) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};
connectDB();

const sessionOptions = {
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.DATABASE_CONNECTION_STRING,
    ttl: 24 * 60 * 60,
  }),
  cookie: {
    secure: isProdLikeEnv,
    sameSite: isProdLikeEnv ? "none" : "lax",
    maxAge: 24 * 60 * 60 * 1000,
  },
};

if ( isProdLikeEnv ) {
  sessionOptions.proxy = true;
}

const app = createApplication({
  env: process.env,
  sessionMiddleware: session(sessionOptions),
});

if ( isProdLikeEnv ) {
  app.set("trust proxy", 1);
}

const port = process.env.PORT || 4050;
app.listen(port, () => {
  console.log(`LeaseQA server listening on port ${port}`);
});
