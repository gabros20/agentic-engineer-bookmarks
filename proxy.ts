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
//  - /login/continue        where an app connection's magic link lands (forwards to the OAuth
//                          authorize endpoint only; holds no data)
//  - /api/auth/*            Better Auth (magic-link verify, sign-out, …)
//  - /api/invite/*          invite-code reservation (login step 1)
//  - /api/login/*           the login page's sign-in email (magic link + 6-digit code in one
//                          email; same send-gate as the bare Better Auth endpoints)
//  - /api/search            the search proxy (T4) — it runs its OWN authoritative
//                          `auth.api.getSession` gate and must return a JSON 401
//                          to fetch() callers, not an HTML /login redirect.
//  - /api/digest,/api/chat,/api/expand  the OpenRouter-backed AI routes (T5) — same
//                          deal as /api/search: each runs its own authoritative
//                          `auth.api.getSession` gate (+ per-user daily quota) and is
//                          hit by fetch()/useObject, so they must return a JSON 401 on
//                          no session, not an HTML /login redirect. The passkey they
//                          used before is retired; the session is now the only gate.
//  - /api/digests,/api/chats,/api/migrate  the T6 history/sync routes — each runs its
//                          own `auth.api.getSession` gate (+ user-scoping) and is hit by
//                          fetch() from the panels, so must return JSON 401, not a
//                          redirect. NOTE: these are distinct prefixes from /api/digest
//                          and /api/chat (the "+ /" boundary means /api/digest does not
//                          match /api/digests), so they are listed explicitly.
//  - /api/archive          the T8 archive proxy — the browser's data Web Worker fetches the
//                          raw bookmark archive here; it runs its OWN `requireUser` gate and
//                          must return a JSON 401 to the fetch() caller, not an HTML redirect.
//  - /api/mcp             the MCP server — authenticated by an OAuth bearer token (requireMcpAuth),
//                          not a cookie; a missing/invalid token must get the JSON-RPC 401 +
//                          WWW-Authenticate challenge that starts the client's OAuth flow.
//  - /.well-known/*        OAuth discovery metadata for MCP clients (public by design, no secrets).
//  - Next internals + static assets  (excluded via the matcher below)
//
// NOTE (T8): /data/* is gone — the bookmark data was moved out of the public CDN into a private
// R2 bucket (search index served server-side to the Worker; the archive via /api/archive above).
// The matcher still excludes `data/` harmlessly (nothing is served there now).
// ---------------------------------------------------------------------------

const ALLOW_PREFIXES = [
  "/api/auth",
  "/api/invite",
  "/api/login",
  "/api/search",
  "/api/digest",
  "/api/digests",
  "/api/chat",
  "/api/chats",
  "/api/migrate",
  "/api/expand",
  "/api/archive",
  "/api/mcp",
  "/.well-known",
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname === "/login" ||
    pathname === "/login/continue" ||
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
