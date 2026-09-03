import type { AuthTokenPayload } from "../middleware/auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthTokenPayload;
    }
  }
}

export {};
