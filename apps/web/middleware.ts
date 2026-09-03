import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Route-level gate: no access_token cookie -> bounce to sign-in.
// This is a UX convenience only — the API independently enforces auth on
// every request regardless of what this middleware does (spec §57).
const PUBLIC_PATHS = ["/", "/register"];

export function middleware(req: NextRequest) {
  const isPublic = PUBLIC_PATHS.includes(req.nextUrl.pathname);
  const hasSession = req.cookies.has("access_token");

  if (!isPublic && !hasSession) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|manifest.json|icons).*)"],
};
