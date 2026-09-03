import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger.js";

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Central error handler — the ONLY place that formats error responses.
// Never leak stack traces, SQL, or internal messages to the client.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    if (err.status >= 500) logger.error({ err }, "api_error_5xx");
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  logger.error({ err }, "unhandled_error");
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Resource not found." } });
}
