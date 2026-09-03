import { createServer } from "node:http";
import { env } from "./config/env.js";
import { logger } from "./utils/logger.js";
import { createApp } from "./app.js";
import { createSocketServer } from "./sockets/index.js";

const app = createApp();
const httpServer = createServer(app);
createSocketServer(httpServer);

httpServer.listen(env.PORT, () => {
  logger.info(`🚀 BOCE Chat API listening on :${env.PORT} (${env.NODE_ENV})`);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down");
  httpServer.close(() => process.exit(0));
});
