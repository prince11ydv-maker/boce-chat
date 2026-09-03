import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { buildVisibleProfile } from "../services/privacy.service.js";
import { ApiError } from "../middleware/errorHandler.js";

// Locked fields per spec §3 — never editable directly, only via a
// ProfileChangeRequest that an Owner/Admin approves.
const LOCKED_FIELDS = ["username", "fullName", "dateOfBirth", "school"] as const;

export const updateProfileSchema = z.object({
  bio: z.string().max(300).optional(),
  location: z.string().max(120).optional(),
  interests: z.array(z.string().max(40)).max(20).optional(),
  socialLinks: z.array(z.object({ platform: z.string(), url: z.string().url() })).max(10).optional(),
  customStatus: z.string().max(80).optional(),
});

export const changeRequestSchema = z.object({
  field: z.enum(LOCKED_FIELDS),
  newValue: z.string().min(1).max(150),
  reason: z.string().max(300).optional(),
});

export async function getProfile(req: Request, res: Response) {
  const viewerId = req.user?.sub ?? null;
  const profile = await buildVisibleProfile(viewerId, req.params.userId);
  if (!profile) throw new ApiError(404, "NOT_FOUND", "User not found.");
  res.json({ profile });
}

// Freely-editable fields only — locked fields are rejected even if present
// in the body, enforced here regardless of what the client UI allows.
export async function updateProfile(req: Request, res: Response) {
  const profile = await prisma.profile.update({
    where: { userId: req.user!.sub },
    data: req.body,
  });
  res.json({ profile });
}

export async function requestProfileChange(req: Request, res: Response) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.sub } });
  const oldValue = String(user[req.body.field as keyof typeof user]);

  const request = await prisma.profileChangeRequest.create({
    data: {
      userId: req.user!.sub,
      field: req.body.field,
      oldValue,
      newValue: req.body.newValue,
      reason: req.body.reason,
    },
  });
  res.status(201).json({ request });
}

// Owner/Admin only (see routes)
export async function reviewProfileChange(req: Request, res: Response) {
  const { decision, note } = req.body as { decision: "APPROVED" | "REJECTED"; note?: string };
  const request = await prisma.profileChangeRequest.findUniqueOrThrow({ where: { id: req.params.id } });

  if (decision === "APPROVED") {
    const fieldMap: Record<string, string> = {
      username: "username",
      fullName: "fullName",
      dateOfBirth: "dateOfBirth",
      school: "school",
    };
    await prisma.user.update({
      where: { id: request.userId },
      data: { [fieldMap[request.field]]: request.field === "dateOfBirth" ? new Date(request.newValue) : request.newValue },
    });
  }

  const updated = await prisma.profileChangeRequest.update({
    where: { id: req.params.id },
    data: { status: decision, reviewedBy: req.user!.sub, reviewNote: note, reviewedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: {
      actorId: req.user!.sub,
      action: `PROFILE_CHANGE_${decision}`,
      targetType: "profile_change_request",
      targetId: updated.id,
    },
  });

  res.json({ request: updated });
}
