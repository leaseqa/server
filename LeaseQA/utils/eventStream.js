// Server-sent events for the endpoints that wait on a chat model. A browser
// asks for a stream by sending `Accept: text/event-stream`; every other caller
// (the eval runner, curl, an old client mid-deploy) keeps the JSON envelope.
import { dataBody, errorBody } from "./responses.js";

const HEARTBEAT_MS = 15_000;

// Only an explicit request counts. `*/*`, which fetch and curl send by default,
// must keep getting JSON, so Express's own req.accepts() is too generous here.
export const acceptsEventStream = (req) =>
  /(^|,)\s*text\/event-stream\s*(;|,|$)/i.test(req.get("accept") || "");

// Writing the cookie is not enough when the session was created by this very
// request: express-session stores it only when the response ends, and any
// request the browser makes with the new cookie before then would find no
// session and get a fresh one instead. Store it before the stream opens.
export const saveSessionBeforeStream = (req) =>
  new Promise((resolve, reject) => {
    if ( typeof req.session?.save !== "function" ) {
      resolve();
      return;
    }
    req.session.save((error) => (error ? reject(error) : resolve()));
  });

/**
 * The stream opens on the first event rather than up front, so a request that
 * fails before any progress (bad input, a missing or foreign session) still
 * answers with its own status code and JSON error. Once the client has gone,
 * before or after the stream opened, every write is dropped; the caller's work
 * carries on and is still stored.
 */
export const createEventStream = (res, { heartbeatMs = HEARTBEAT_MS } = {}) => {
  let opened = false;
  let closed = false;
  let heartbeat = null;

  const stop = () => {
    closed = true;
    clearInterval(heartbeat);
  };
  // Listening from the start, so a client that leaves before the first event
  // is not mistaken for one still reading.
  res.on("close", stop);

  const open = () => {
    opened = true;
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      // Tells nginx-style proxies not to hold the stream back in a buffer.
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    // A comment line now and then keeps idle-timeout proxies from cutting the
    // connection while the model is still working on its first words.
    heartbeat = setInterval(() => {
      if ( !closed ) {
        res.write(": keep-alive\n\n");
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  };

  /** Returns whether the event went to a client that is still connected. */
  const send = (event, data) => {
    if ( closed ) {
      return false;
    }
    if ( !opened ) {
      open();
    }
    // JSON.stringify escapes newlines, so one data line always suffices.
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  };

  const end = () => {
    if ( closed ) {
      return;
    }
    stop();
    res.end();
  };

  return {
    get opened() {
      return opened;
    },
    /** A progress event; see onEvent in RAG/service.js. */
    send,
    /** The last event on success: the body the JSON response would carry. */
    done(data) {
      send("done", dataBody(data));
      end();
    },
    /**
     * The last event on failure: the JSON error body, plus the status code the
     * JSON response would have used, which a 200 stream cannot carry itself.
     */
    fail({ code, message, status }) {
      send("error", { ...errorBody({ code, message }), status });
      end();
    },
  };
};
