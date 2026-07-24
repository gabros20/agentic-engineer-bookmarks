import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// ---------------------------------------------------------------------------
// Login wall (T3) — Next 16 proxy (the renamed `middleware` convention).
//
// This is the OPTIMISTIC fast path: any request lacking a Better Auth session
// cookie is bounced to /login before it reaches a route. It does NOT hit the DB
// (`getSessionCookie` only reads the signed cookie's presence). The AUTHORITATIVE
// gate lives in app/page.tsx (`auth.api.getSession`), which a forged/edited
// cookie cannot pass — so the app shell never renders without a real session.
//
// Allow-list (reachable without a session):
//  - /login                 the login UI itself
//  - /api/auth/*            Better Auth (magic-link verify, sign-out, …)
//  - /api/invite/*          invite-code reservation (login step 1)
//  - /api/search            the search proxy (T4) — it runs its OWN authoritative
//                          `auth.api.getSession` gate and must return a JSON 401
//                          to fetch() callers, not an HTML /login redirect.
//  - Next internals + static assets  (excluded via the matcher below)
//  - /data/*               static JSON the Cloudflare Worker fetches from Vercel
//                          with NO cookie; blocking it would break prod search.
// ---------------------------------------------------------------------------

const ALLOW_PREFIXES = ["/api/auth", "/api/invite", "/api/search"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === "/login" ||
    ALLOW_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))
  ) {
    return NextResponse.next();
  }

  // Optimistic check only — presence of the session cookie. The real
  // verification happens server-side in the gated page.
  if (getSessionCookie(request)) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl, 307);
}

export const config = {
  // Run on everything EXCEPT Next internals, the public data files the Worker
  // fetches, favicon, and static assets by extension. The allow-list above
  // handles /login and the auth/invite APIs.
  matcher: [
    "/((?!_next/static|_next/image|data/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|json|woff2?)$).*)",
  ],
};
