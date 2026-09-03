import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import jwt from "jsonwebtoken";
import Redis from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { registerPresenceHandlers } from "./presence.js";
import { registerChatHandlers } from "./chat.gateway.js";
import type { AuthTokenPayload } from "../middleware/auth.js";

// Socket.IO with a Redis adapter so events fan out correctly once the API
// runs as more than one process/container behind a load balancer.
export function createSocketServer(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: { origin: env.WEB_ORIGIN, credentials: true },
  });

  const pubClient = new Redis(env.REDIS_URL);
  const subClient = pubClient.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

  // Auth handshake — reject the connection before any event handler runs
  // if the access token is missing or invalid. Same JWT used by the REST API.
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("UNAUTHENTICATED"));
    try {
      const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AuthTokenPayload;
      socket.data.user = payload;
      next();
    } catch {
      next(new Error("INVALID_TOKEN"));
    }
  });

  io.on("connection", (socket) => {
    logger.debug({ userId: socket.data.user.sub }, "socket_connected");
    registerPresenceHandlers(io, socket);
    registerChatHandlers(io, socket);

    socket.on("disconnect", () => {
      logger.debug({ userId: socket.data.user.sub }, "socket_disconnected");
    });
  });

  return io;
}
