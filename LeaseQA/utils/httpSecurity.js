import { randomUUID } from "node:crypto";
import cors from "cors";
import helmet from "helmet";

const PLACEHOLDER_SESSION_SECRETS = new Set([
  "change-me",
  "changeme",
  "leaseqa-secret",
  "leaseqa-development-only-secret",
  "secret",
  "your-session-secret",
]);

const splitOrigins = (value = "") => value
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const buildCorsOptions = (env = process.env) => {
  const allowedOrigins = new Set([
    ...splitOrigins(env.CLIENT_URL),
    ...splitOrigins(env.CORS_ALLOWED_ORIGINS),
  ]);

  if ( allowedOrigins.size === 0 ) allowedOrigins.add("http://localhost:3000");

  return {
    credentials: true,
    origin(origin, callback) {
      if ( !origin || allowedOrigins.has(origin) ) return callback(null, true);
      return callback(new Error("CORS origin denied"));
    },
  };
};

export const assertProductionSessionConfig = (env = process.env) => {
  const configuredSecret = env.SESSION_SECRET?.trim();
  if ( env.SERVER_ENV === "production" ) {
    if (
      !configuredSecret ||
      PLACEHOLDER_SESSION_SECRETS.has(configuredSecret.toLowerCase())
    ) {
      throw new Error("Production requires a non-placeholder SESSION_SECRET.");
    }
    return configuredSecret;
  }

  return configuredSecret || "leaseqa-development-only-secret";
};

export const requestIdMiddleware = (req, res, next) => {
  req.requestId = randomUUID();
  res.setHeader("X-Request-ID", req.requestId);
  next();
};

export const applyHttpSecurity = (app, env = process.env) => {
  app.disable("x-powered-by");
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.use("/uploads", helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
  app.use(cors(buildCorsOptions(env)));
};

export const unexpectedErrorHandler = (_error, req, res, _next) => {
  const requestId = req.requestId || randomUUID();
  console.error(JSON.stringify({ event: "unexpected_error", requestId }));
  return res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected server error occurred.",
      requestId,
    },
  });
};
