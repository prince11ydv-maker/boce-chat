import { Router } from "express";
import { authRateLimit } from "../middleware/rateLimit.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth } from "../middleware/auth.js";
import * as auth from "../controllers/auth.controller.js";

export const authRouter = Router();

authRouter.post("/register", authRateLimit, validateBody(auth.registerSchema), auth.register);
authRouter.post("/login", authRateLimit, validateBody(auth.loginSchema), auth.login);
authRouter.post("/logout", requireAuth, auth.logout);
authRouter.get("/me", requireAuth, auth.me);
