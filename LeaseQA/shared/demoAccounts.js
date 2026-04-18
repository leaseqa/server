export const DEMO_ACCOUNT_EMAILS = new Set([
  "admin@leaseqa.dev",
  "tenant@leaseqa.dev",
  "casey@leaseqa.dev",
  "jordan@leaseqa.dev",
  "sam@leaseqa.dev",
  "alex@leaseqa.dev",
  "riley@leaseqa.dev",
  "lena@leaseqa.dev",
  "marcus@leaseqa.dev",
]);

export const normalizeEmail = (email = "") => String(email).trim().toLowerCase();

export const isDemoAccountEmail = (email) =>
  DEMO_ACCOUNT_EMAILS.has(normalizeEmail(email));

export const areDemoAccountsAllowed = (env = process.env) => {
  if (env.ALLOW_DEMO_ACCOUNTS === "true") {
    return true;
  }

  const runtimeEnv = env.SERVER_ENV || env.NODE_ENV || "";
  return !runtimeEnv || runtimeEnv === "development" || runtimeEnv === "test";
};

export const isBlockedDemoAccount = (email, env = process.env) =>
  isDemoAccountEmail(email) && !areDemoAccountsAllowed(env);

export const assertDemoAccountsAllowed = (env = process.env) => {
  if (areDemoAccountsAllowed(env)) {
    return;
  }

  throw new Error(
    "Demo accounts are disabled outside development. Set ALLOW_DEMO_ACCOUNTS=true only for explicit local or CI seeding.",
  );
};
