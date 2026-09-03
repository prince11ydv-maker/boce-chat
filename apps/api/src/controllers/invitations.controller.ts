import type { Request, Response } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { validateInvitationCode } from "../services/invitation.service.js";

export const createInvitationSchema = z.object({
  purpose: z.string().max(200).optional(),
  maxUses: z.number().int().min(1).max(10000).default(1),
  expiresAt: z.string().datetime().optional(),
});

function generateCode(): string {
  return crypto.randomBytes(6).toString("base64url").toUpperCase().slice(0, 8);
}

// Owner/Admin only (see routes) — create an invitation code.
export async function createInvitation(req: Request, res: Response) {
  const invitation = await prisma.invitation.create({
    data: {
      code: generateCode(),
      createdById: req.user!.sub,
      purpose: req.body.purpose,
      maxUses: req.body.maxUses,
      expiresAt: req.body.expiresAt ? new Date(req.body.expiresAt) : undefined,
    },
  });
  await prisma.auditLog.create({
    data: { actorId: req.user!.sub, action: "INVITATION_CREATED", targetType: "invitation", targetId: invitation.id },
  });
  res.status(201).json({ invitation });
}

export async function listInvitations(req: Request, res: Response) {
  const invitations = await prisma.invitation.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { _count: { select: { usages: true } } },
  });
  res.json({ invitations });
}

export async function disableInvitation(req: Request, res: Response) {
  const invitation = await prisma.invitation.update({
    where: { id: req.params.id },
    data: { status: "DISABLED" },
  });
  await prisma.auditLog.create({
    data: { actorId: req.user!.sub, action: "INVITATION_DISABLED", targetType: "invitation", targetId: invitation.id },
  });
  res.json({ invitation });
}

// Public — used by the registration form to validate a code before submit,
// without leaking who created it or how many uses remain.
export async function checkInvitation(req: Request, res: Response) {
  const invitation = await validateInvitationCode(req.params.code);
  res.json({ valid: true, purpose: invitation.purpose });
}
