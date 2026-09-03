import { Router } from "express";
import { authRouter } from "./auth.routes.js";
import { invitationsRouter } from "./invitations.routes.js";
import { usersRouter } from "./users.routes.js";
import { chatsRouter } from "./chats.routes.js";

export const apiRouter = Router();

apiRouter.use("/auth", authRouter);
apiRouter.use("/invitations", invitationsRouter);
apiRouter.use("/users", usersRouter);
apiRouter.use("/chats", chatsRouter);

// Friends, groups, communities, posts, stories, calls, notifications,
// reports, and admin-dashboard routes follow the same pattern and are
// the next slice to build once this foundation is validated.
