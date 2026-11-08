// The two response bodies every endpoint answers with, whether it sends them
// as JSON or as the final event of a stream (see eventStream.js).
export const dataBody = (data) => ({ data });

export const errorBody = ({ code = "INTERNAL_ERROR", message = "Unexpected error", details = null }) => {
  const payload = { error: { code, message } };
  if ( details ) {
    payload.error.details = details;
  }
  return payload;
};

export const sendData = (res, data, status = 200) => {
  res.status(status).json(dataBody(data));
};

export const sendError = (res, { status = 500, ...body }) => {
  res.status(status).json(errorBody(body));
};

export const sendNotFound = (res, message = "Resource not found") =>
  sendError(res, { code: "NOT_FOUND", message, status: 404 });

export const sendUnauthorized = (res, message = "Authentication required") =>
  sendError(res, { code: "UNAUTHORIZED", message, status: 401 });

export const sendForbidden = (res, message = "Forbidden") =>
  sendError(res, { code: "FORBIDDEN", message, status: 403 });
