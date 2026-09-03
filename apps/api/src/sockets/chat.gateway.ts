import type { Server, Socket } from "socket.io";
import { prisma } from "../config/prisma.js";
import { logger } from "../utils/logger.js";

interface SendMessagePayload {
  chatId: string;
  clientId: string; // client-generated id for optimistic-UI reconciliation
  type: "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT" | "VOICE" | "LOCATION" | "LINK";
  body?: string;
  replyToId?: string;
}

// Real-time message send/typing/read-receipt events. REST handles history
// pagination (GET /chats/:id/messages); sockets handle everything live.
export function registerChatHandlers(io: Server, socket: Socket) {
  const userId = socket.data.user.sub as string;

  socket.on("chat:join", async (chatId: string) => {
    const membership = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
    });
    if (!membership) return; // silently ignore — never confirm a chat's existence to a non-member
    socket.join(`chat:${chatId}`);
  });

  socket.on("chat:send", async (payload: SendMessagePayload, ack?: (result: unknown) => void) => {
    const membership = await prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId: payload.chatId, userId } },
    });
    if (!membership) return ack?.({ error: "FORBIDDEN" });

    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: payload.chatId } });

    const message = await prisma.message.create({
      data: {
        chatId: payload.chatId,
        senderId: userId,
        type: payload.type,
        body: payload.body, // NOTE: E2E ciphertext path replaces `body` — see docs/ENCRYPTION.md
        replyToId: payload.replyToId,
        status: "SENT",
        expiresAt: chat.disappearingSeconds
          ? new Date(Date.now() + chat.disappearingSeconds * 1000)
          : null,
      },
    });

    await prisma.chat.update({ where: { id: payload.chatId }, data: { updatedAt: new Date() } });

    io.to(`chat:${payload.chatId}`).emit("chat:message", { ...message, clientId: payload.clientId });
    ack?.({ message });
  });

  socket.on("chat:typing", ({ chatId, isTyping }: { chatId: string; isTyping: boolean }) => {
    socket.to(`chat:${chatId}`).emit("chat:typing", { chatId, userId, isTyping });
  });

  socket.on("chat:read", async ({ chatId }: { chatId: string }) => {
    await prisma.chatMember.update({
      where: { chatId_userId: { chatId, userId } },
      data: { lastReadAt: new Date() },
    });
    socket.to(`chat:${chatId}`).emit("chat:read", { chatId, userId, at: new Date().toISOString() });
  });

  socket.on("error", (err) => logger.error({ err, userId }, "socket_handler_error"));
}
