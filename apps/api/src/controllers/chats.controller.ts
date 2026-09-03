import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/prisma.js";
import { ApiError } from "../middleware/errorHandler.js";
import { isBlocked } from "../services/privacy.service.js";

export const createDirectChatSchema = z.object({
  userId: z.string().uuid(),
});

// List chats for the current user, most-recently-active first, with only
// the last message preview — never the full history — for a fast list view.
export async function listChats(req: Request, res: Response) {
  const memberships = await prisma.chatMember.findMany({
    where: { userId: req.user!.sub },
    include: {
      chat: {
        include: {
          members: { include: { user: { include: { profile: true } } } },
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
    orderBy: { chat: { updatedAt: "desc" } },
  });
  res.json({ chats: memberships.map((m) => m.chat) });
}

export async function createDirectChat(req: Request, res: Response) {
  const { userId: otherUserId } = req.body;
  if (otherUserId === req.user!.sub) {
    throw new ApiError(400, "INVALID_TARGET", "You can't start a direct chat with yourself.");
  }
  if (await isBlocked(req.user!.sub, otherUserId)) {
    throw new ApiError(403, "BLOCKED", "You can't message this user.");
  }

  // Reuse an existing direct chat between these two users if one exists.
  const existing = await prisma.chat.findFirst({
    where: {
      type: "DIRECT",
      AND: [{ members: { some: { userId: req.user!.sub } } }, { members: { some: { userId: otherUserId } } }],
    },
  });
  if (existing) return res.json({ chat: existing });

  const chat = await prisma.chat.create({
    data: {
      type: "DIRECT",
      members: { create: [{ userId: req.user!.sub, role: "MEMBER" }, { userId: otherUserId, role: "MEMBER" }] },
    },
    include: { members: true },
  });
  res.status(201).json({ chat });
}

// Paginated message history — never the whole chat at once (spec §51).
export async function listMessages(req: Request, res: Response) {
  const membership = await prisma.chatMember.findUnique({
    where: { chatId_userId: { chatId: req.params.chatId, userId: req.user!.sub } },
  });
  if (!membership) throw new ApiError(403, "FORBIDDEN", "You're not a member of this chat.");

  const cursor = req.query.cursor as string | undefined;
  const messages = await prisma.message.findMany({
    where: { chatId: req.params.chatId },
    orderBy: { createdAt: "desc" },
    take: 30,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  res.json({ messages, nextCursor: messages.length === 30 ? messages[messages.length - 1].id : null });
}
