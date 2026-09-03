import { prisma } from "../config/prisma.js";
import { ApiError } from "../middleware/errorHandler.js";
import type { PrismaClient } from "@prisma/client";

// Central invite-code validation used by registration. Kept isolated
// so admin tooling and registration both go through one source of truth.
export async function validateInvitationCode(code: string) {
  const invitation = await prisma.invitation.findUnique({ where: { code } });

  if (!invitation) {
    throw new ApiError(400, "INVALID_INVITE", "That invitation code isn't valid.");
  }
  if (invitation.status !== "ACTIVE") {
    throw new ApiError(400, "INVITE_UNAVAILABLE", "That invitation code is no longer active.");
  }
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    throw new ApiError(400, "INVITE_EXPIRED", "That invitation code has expired.");
  }
  if (invitation.useCount >= invitation.maxUses) {
    throw new ApiError(400, "INVITE_EXHAUSTED", "That invitation code has already been used up.");
  }

  return invitation;
}

type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

// Redeems the code atomically as part of the registration transaction so
// two concurrent signups can never both slip through on a maxUses:1 code.
// Uses a raw conditional UPDATE (useCount < maxUses) so the "is there a
// slot left" check and the increment happen as one atomic DB operation —
// no read-then-write race between two simultaneous signups.
export async function redeemInvitationCode(tx: Tx, invitationId: string, userId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    UPDATE invitations
    SET "useCount" = "useCount" + 1
    WHERE id = ${invitationId} AND "useCount" < "maxUses" AND status = 'ACTIVE'
    RETURNING id
  `;

  if (rows.length === 0) {
    throw new ApiError(409, "INVITE_UNAVAILABLE", "That invitation code was just used up. Please request a new one.");
  }

  await tx.invitationUsage.create({ data: { invitationId, userId } });
}
