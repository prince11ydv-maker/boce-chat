import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";
import { ApiError } from "./errorHandler.js";

// Wrap a Zod schema as Express middleware. Every mutating route validates
// its body server-side — the frontend's own validation is a UX nicety,
// never the source of truth.
export function validateBody(schema: ZodSchema) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(new ApiError(400, "VALIDATION_ERROR", "Invalid request body", result.error.flatten()));
    }
    req.body = result.data;
    next();
  };
}
