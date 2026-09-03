import Redis from "ioredis";
import { env } from "./env.js";

// Used for: presence (online/last-seen), rate limiting, and as the
// Socket.IO adapter so real-time events fan out across multiple API
// instances instead of being trapped on one process.
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});
