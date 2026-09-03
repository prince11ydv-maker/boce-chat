import { prisma } from "../config/prisma.js";
import type { Visibility } from "@prisma/client";

// Single source of truth for "can viewerId see this field of targetId".
// Every profile-serving endpoint (REST, search, feed, socket presence)
// must call through here — never re-implement this check inline, or a
// new endpoint will inevitably leak something a user marked private.
export async function canView(
  viewerId: string | null,
  targetUserId: string,
  visibility: Visibility
): Promise<boolean> {
  if (viewerId === targetUserId) return true;

  switch (visibility) {
    case "PUBLIC":
      return true;
    case "PRIVATE":
      return false;
    case "FRIENDS":
    case "CUSTOM": // TODO: CUSTOM audience lists — treated as FRIENDS until implemented
      if (!viewerId) return false;
      return areFriends(viewerId, targetUserId);
    default:
      return false;
  }
}

export async function areFriends(userAId: string, userBId: string): Promise<boolean> {
  const [a, b] = [userAId, userBId].sort();
  const friendship = await prisma.friendship.findUnique({
    where: { userAId_userBId: { userAId: a, userBId: b } },
  });
  return !!friendship;
}

export async function isBlocked(userAId: string, userBId: string): Promise<boolean> {
  const block = await prisma.blockedUser.findFirst({
    where: {
      OR: [
        { blockerId: userAId, blockedId: userBId },
        { blockerId: userBId, blockedId: userAId },
      ],
    },
  });
  return !!block;
}

// Strips fields a viewer isn't allowed to see. Used by the profile
// controller so the wire response itself never contains the private
// data — not just a UI that hides it.
export async function buildVisibleProfile(viewerId: string | null, targetUserId: string) {
  const user = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { profile: true, privacySettings: true },
  });
  if (!user) return null;

  const privacy = user.privacySettings;
  const out: Record<string, unknown> = {
    id: user.id,
    username: user.username,
    avatarUrl: user.profile?.avatarUrl ?? null,
  };

  if (!privacy || (await canView(viewerId, user.id, privacy.profileVisibility))) {
    out.fullName = user.fullName;
    out.bio = user.profile?.bio ?? null;
    out.coverUrl = user.profile?.coverUrl ?? null;
    out.interests = user.profile?.interests ?? [];
    out.customStatus = user.profile?.customStatus ?? null;
  }

  if (privacy && (await canView(viewerId, user.id, privacy.dobVisibility))) {
    out.dateOfBirth = user.dateOfBirth;
  }

  if (privacy && (await canView(viewerId, user.id, privacy.schoolVisibility))) {
    out.school = user.school;
  }

  return out;
}
