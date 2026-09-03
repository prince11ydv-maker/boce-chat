import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { ApiError } from "./errorHandler.js";
import type { PlatformRole } from "@prisma/client";

export interface AuthTokenPayload {
  sub: string; // userId
  role: PlatformRole;
}

// Populates req.user from a valid access token. Every route that touches
// user-specific or privileged data must sit behind this — nothing is
// inferred from client-supplied user IDs.
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : req.cookies?.access_token;

  if (!token) {
    return next(new ApiError(401, "UNAUTHENTICATED", "Sign in required."));
  }

  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AuthTokenPayload;
    req.user = payload;
    next();
  } catch {
    next(new ApiError(401, "INVALID_TOKEN", "Session expired or invalid. Please sign in again."));
  }
}

// Role gate — Owner > Admin > Moderator > User. Checked server-side only;
// the frontend showing/hiding an "Admin" button has zero bearing on this.
const ROLE_RANK: Record<PlatformRole, number> = {
  USER: 0,
  MODERATOR: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function requireRole(minRole: PlatformRole) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new ApiError(401, "UNAUTHENTICATED", "Sign in required."));
    if (ROLE_RANK[req.user.role] < ROLE_RANK[minRole]) {
      return next(new ApiError(403, "FORBIDDEN", "You don't have permission to do that."));
    }
    next();
  };
}
