import { AppError } from "./AppError";

export class BadRequestError extends AppError {
  constructor(message: string, code = "BAD_REQUEST") {
    super(400, message, code);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message, "VALIDATION_ERROR");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, message, "UNAUTHORIZED");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Access denied") {
    super(403, message, "FORBIDDEN");
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, message, "NOT_FOUND");
  }
}

export class ConflictError extends AppError {
  constructor(message: string, code = "CONFLICT") {
    super(409, message, code);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message: string, retryAfterSeconds: number) {
    super(429, message, "TOO_MANY_REQUESTS", { retryAfterSeconds });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message: string, code = "SERVICE_UNAVAILABLE", retryAfterSeconds?: number) {
    super(503, message, code, { retryAfterSeconds });
  }
}
