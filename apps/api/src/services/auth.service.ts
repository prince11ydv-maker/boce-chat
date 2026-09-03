import { prisma } from "../config/prisma.js";
import { ApiError } from "../middleware/errorHandler.js";
import { hashPassword, verifyPassword } from "./password.service.js";
import { validateInvitationCode, redeemInvitationCode } from "./invitation.service.js";
import { signAccessToken, generateRefreshToken } from "./token.service.js";

export interface RegisterInput {
  username: string;
  password: string;
  fullName: string;
  dateOfBirth: string; // ISO date
  school: string;
  invitationCode: string;
  email?: string;
}

export async function registerUser(input: RegisterInput, device: { name: string; platform: string; ip?: string }) {
  const usernameTaken = await prisma.user.findUnique({ where: { username: input.username } });
  if (usernameTaken) {
    throw new ApiError(409, "USERNAME_TAKEN", "That username is already in use.");
  }

  const invitation = await validateInvitationCode(input.invitationCode);
  const passwordHash = await hashPassword(input.password);

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username: input.username,
        fullName: input.fullName,
        dateOfBirth: new Date(input.dateOfBirth),
        school: input.school,
        passwordHash,
        profile: { create: {} },
        privacySettings: { create: {} },
        notificationSettings: { create: {} },
      },
    });

    if (input.email) {
      await tx.authAccount.create({
        data: { userId: user.id, provider: "EMAIL", identifier: input.email.toLowerCase() },
      });
    }
    await tx.authAccount.create({
      data: { userId: user.id, provider: "USERNAME", identifier: input.username },
    });

    // Every user gets a private "Saved Messages" self-chat on creation.
    await tx.chat.create({
      data: { type: "SELF", members: { create: { userId: user.id, role: "OWNER" } } },
    });

    await redeemInvitationCode(tx, invitation.id, user.id);

    await tx.auditLog.create({
      data: { actorId: user.id, action: "USER_REGISTERED", targetType: "user", targetId: user.id },
    });

    return user;
  });

  return issueSession(result.id, result.platformRole, device);
}

export async function loginWithPassword(
  identifier: string,
  password: string,
  device: { name: string; platform: string; ip?: string }
) {
  const account = await prisma.authAccount.findFirst({
    where: { identifier: identifier.toLowerCase(), provider: { in: ["EMAIL", "USERNAME"] } },
    include: { user: true },
  });

  // Constant-shape response whether the account exists or the password is
  // wrong — don't let this endpoint reveal which usernames/emails exist.
  if (!account || !account.user.passwordHash) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Incorrect username/email or password.");
  }

  const valid = await verifyPassword(account.user.passwordHash, password);
  if (!valid) {
    await prisma.securityLog.create({
      data: { userId: account.user.id, event: "login_failed", ipAddress: device.ip },
    });
    throw new ApiError(401, "INVALID_CREDENTIALS", "Incorrect username/email or password.");
  }

  if (account.user.status !== "ACTIVE") {
    throw new ApiError(403, "ACCOUNT_UNAVAILABLE", "This account is not currently active.");
  }

  await prisma.securityLog.create({
    data: { userId: account.user.id, event: "login", ipAddress: device.ip },
  });

  return issueSession(account.user.id, account.user.platformRole, device);
}

async function issueSession(userId: string, role: "OWNER" | "ADMIN" | "MODERATOR" | "USER", device: { name: string; platform: string; ip?: string }) {
  const deviceRecord = await prisma.device.create({
    data: { userId, name: device.name, platform: device.platform },
  });

  const accessToken = signAccessToken({ sub: userId, role });
  const { token: refreshToken, hash } = generateRefreshToken();

  await prisma.session.create({
    data: {
      userId,
      deviceId: deviceRecord.id,
      refreshTokenHash: hash,
      ipAddress: device.ip,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  return { accessToken, refreshToken, deviceId: deviceRecord.id };
}
