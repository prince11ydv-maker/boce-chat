import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import * as inv from "../controllers/invitations.controller.js";

export const invitationsRouter = Router();

invitationsRouter.get("/:code/check", inv.checkInvitation); // public
invitationsRouter.get("/", requireAuth, requireRole("ADMIN"), inv.listInvitations);
invitationsRouter.post("/", requireAuth, requireRole("ADMIN"), validateBody(inv.createInvitationSchema), inv.createInvitation);
invitationsRouter.post("/:id/disable", requireAuth, requireRole("ADMIN"), inv.disableInvitation);
