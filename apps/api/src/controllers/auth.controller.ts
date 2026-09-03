import type { Request, Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { registerUser, loginWithPassword } from "../services/auth.service.js";
import { prisma } from "../config/prisma.js";

export const registerSchema = z.object({
  username: z.string().min(3).max(24).regex(/^[a-zA-Z0-9_.]+$/, "Letters, numbers, dots and underscores only"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  fullName: z.string().min(1).max(100),
  dateOfBirth: z.string().date(),
  school: z.string().min(1).max(150),
  invitationCode: z.string().min(4),
  email: z.string().email().optional(),
});

export const loginSchema = z.object({
  identifier: z.string().min(1), // username or email
  password: z.string().min(1),
});

const REFRESH_COOKIE = "refresh_token";
const ACCESS_COOKIE = "access_token";

function setSessionCookies(res: Response, accessToken: string, refreshToken: string) {
  const secure = env.NODE_ENV === "production";
  res.cookie(ACCESS_COOKIE, accessToken, { httpOnly: true, secure, sameSite: "lax", maxAge: 15 * 60 * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/api/auth/refresh",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export async function register(req: Request, res: Response) {
  const { accessToken, refreshToken } = await registerUser(req.body, {
    name: req.headers["user-agent"]?.slice(0, 80) ?? "Unknown device",
    platform: "web",
    ip: req.ip,
  });
  setSessionCookies(res, accessToken, refreshToken);
  res.status(201).json({ accessToken });
}

export async function login(req: Request, res: Response) {
  const { accessToken, refreshToken } = await loginWithPassword(req.body.identifier, req.body.password, {
    name: req.headers["user-agent"]?.slice(0, 80) ?? "Unknown device",
    platform: "web",
    ip: req.ip,
  });
  setSessionCookies(res, accessToken, refreshToken);
  res.json({ accessToken });
}

export async function logout(req: Request, res: Response) {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) {
    const { hashRefreshToken } = await import("../services/token.service.js");
    await prisma.session.updateMany({
      where: { refreshTokenHash: hashRefreshToken(token) },
      data: { revokedAt: new Date() },
    });
  }
  res.clearCookie(ACCESS_COOKIE);
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth/refresh" });
  res.status(204).send();
}

export async function me(req: Request, res: Response) {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.sub },
    include: { profile: true },
  });
  res.json({ user });
}
