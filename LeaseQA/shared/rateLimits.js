import { ipKeyGenerator } from "express-rate-limit";

import { sendError } from "../utils/responses.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// A single lease review spends several requests before it shows anything: the
// session list on page load, the create call, a status poll every two seconds
// while the source indexes, and one request per follow-up question. Counting
// all of that against one small hourly budget locked users out part-way
// through — the 429s landed on the polling reads, which cost nothing, and
// starved the request that was actually doing the work.
//
// So the two are budgeted apart. Reads get room for the polling the UI needs.
// The endpoints that spend embedding and generation credit keep a real
// ceiling, just one high enough for a person to finish a review and ask
// follow-ups rather than one that stops them mid-answer.
export const RAG_READ_LIMIT = { windowMs: HOUR, max: 240 };
export const RAG_WRITE_LIMIT = { windowMs: HOUR, max: 20 };

export const isRagRead = (method) =>
  method === "GET" || method === "HEAD" || method === "OPTIONS";

// Only the requests that test a credential spend the sign-in budget. It used to
// cover all of /api/auth, so the session check every page load makes used it up
// too: ten loads in fifteen minutes and the next sign-in got a 429, and a
// signed-in user who reloaded was shown as signed out.
export const CREDENTIAL_ROUTES = ["/api/auth/login", "/api/auth/register"];
export const CREDENTIAL_LIMIT = { windowMs: 15 * MINUTE, max: 10 };

// The budget belongs to the account, not the address. Requests reach the server
// through Render's Cloudflare edge (and Vercel's rewrite before that), and
// index.js trusts one hop, so req.ip is an edge node that many users share: one
// person's failed attempts locked out everyone behind the same node. Keying by
// the account still stops anyone guessing one password, from any address.
export const credentialKey = (req) => {
  const userId = req.session?.currentUser?._id;
  if ( userId ) return `user:${userId}`;
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  return email ? `email:${email}` : `ip:${ipKeyGenerator(req.ip)}`;
};

// Every limiter answers with the same JSON error body as the routes, so the
// client can show the message instead of "Request failed with status code 429".
export const rateLimitedResponse = (message) => (_req, res, _next, options) =>
  sendError(res, { code: "RATE_LIMITED", message, status: options.statusCode });
