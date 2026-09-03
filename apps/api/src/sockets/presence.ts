import type { Server, Socket } from "socket.io";
import { redis } from "../config/redis.js";
import { prisma } from "../config/prisma.js";
import { canView } from "../services/privacy.service.js";

const PRESENCE_TTL_SECONDS = 60;

// Online/last-seen state lives in Redis (cheap, ephemeral, expiring) —
// never as a permanent DB write per heartbeat.
export function registerPresenceHandlers(io: Server, socket: Socket) {
  const userId = socket.data.user.sub as string;

  markOnline(userId);
  socket.on("presence:heartbeat", () => markOnline(userId));

  socket.on("presence:subscribe", async (targetUserId: string, ack?: (state: unknown) => void) => {
    const privacy = await prisma.privacySettings.findUnique({ where: { userId: targetUserId } });
    const allowed = !privacy || (await canView(userId, targetUserId, privacy.onlineStatusVisibility));
    if (!allowed) return ack?.({ visible: false });

    const isOnline = await redis.get(presenceKey(targetUserId));
    ack?.({ visible: true, online: !!isOnline });
  });

  socket.on("disconnect", async () => {
    // Grace period before flipping to "offline" in case of a quick reconnect.
    setTimeout(async () => {
      const stillConnected = (await io.in(`user:${userId}`).fetchSockets()).length > 0;
      if (!stillConnected) await redis.del(presenceKey(userId));
    }, 5_000);
  });

  socket.join(`user:${userId}`);
}

async function markOnline(userId: string) {
  await redis.set(presenceKey(userId), "1", "EX", PRESENCE_TTL_SECONDS);
}

function presenceKey(userId: string) {
  return `presence:${userId}`;
}
