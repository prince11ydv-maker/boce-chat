import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import * as users from "../controllers/users.controller.js";

export const usersRouter = Router();

usersRouter.get("/:userId/profile", users.getProfile); // optionalAuth pattern: works logged-out for public profiles
usersRouter.patch("/me/profile", requireAuth, validateBody(users.updateProfileSchema), users.updateProfile);
usersRouter.post("/me/profile-change-requests", requireAuth, validateBody(users.changeRequestSchema), users.requestProfileChange);
usersRouter.post(
  "/profile-change-requests/:id/review",
  requireAuth,
  requireRole("ADMIN"),
  users.reviewProfileChange
);
