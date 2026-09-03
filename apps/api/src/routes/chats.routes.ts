import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import * as chats from "../controllers/chats.controller.js";

export const chatsRouter = Router();

chatsRouter.get("/", requireAuth, chats.listChats);
chatsRouter.post("/direct", requireAuth, validateBody(chats.createDirectChatSchema), chats.createDirectChat);
chatsRouter.get("/:chatId/messages", requireAuth, chats.listMessages);
