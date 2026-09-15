const HOUR = 60 * 60 * 1000;

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
