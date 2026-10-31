import { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../errors/AppError";
import { NotFoundError } from "../errors/http-errors";

const defaultCodes: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "TOO_MANY_REQUESTS",
  503: "SERVICE_UNAVAILABLE",
};

export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch((error: unknown) => {
        next(error instanceof Error ? error : new Error("Non-Error rejection"));
      });
  };
}

export const notFound: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError("Route not found"));
};

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) return next(error);

  const failure = error as { statusCode?: unknown; status?: unknown };
  const status = failure?.statusCode ?? failure?.status;
  const validStatus = typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599;
  const statusCode = validStatus ? status : 500;
  let code = statusCode < 500 ? "REQUEST_ERROR" : "INTERNAL_ERROR";
  let message = statusCode < 500 ? "Request failed" : "Internal server error";

  if (error instanceof AppError && validStatus) {
    if (statusCode < 500 || (statusCode === 503 && error.code === "BOOKING_BUSY")) {
      code = error.code || defaultCodes[statusCode] || "REQUEST_ERROR";
      message = error.message;
    } else if (statusCode === 503) {
      code = "SERVICE_UNAVAILABLE";
      message = "Service unavailable";
    }
    const retryAfter = error.retryAfterSeconds;
    if ((statusCode === 429 || statusCode === 503)
      && typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter > 0) {
      res.setHeader("Retry-After", String(retryAfter));
    }
  }

  if (statusCode >= 500) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "http_request_failed",
      method: req.method,
      route: typeof req.route?.path === "string" ? req.route.path : "unmatched",
      statusCode,
      code,
    }));
  }
  res.status(statusCode).json({ message, code });
};
