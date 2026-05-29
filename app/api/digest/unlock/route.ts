import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";

const COOKIE_NAME = "digest_unlock";
const ONE_YEAR_S = 60 * 60 * 24 * 365;

export function GET(request: NextRequest) {
  const expected = process.env.DIGEST_UNLOCK_SECRET;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "Server misconfigured: DIGEST_UNLOCK_SECRET unset" }, { status: 500 });
  }

  const provided = request.nextUrl.searchParams.get("key");
  if (!provided || provided !== expected) {
    return NextResponse.json({ ok: false, error: "Invalid key" }, { status: 401 });
  }

  const response = new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>AI Digest unlocked</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font:16px/1.5 -apple-system,system-ui,sans-serif;padding:2rem;max-width:32rem;margin:auto;color:#0f1419"><h1 style="margin:0 0 .5rem">AI Digest unlocked</h1><p style="color:#536471">The AI Digest button is now enabled on this browser for one year. Return to the app and try a search.</p><p><a href="/" style="color:#1d9bf0;text-decoration:none;font-weight:700">← Back to bookmarks</a></p></body></html>`,
    {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );

  const cookieOpts = {
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_S,
  };

  // Server-side auth cookie: actual secret, never readable from JS.
  response.cookies.set(COOKIE_NAME, expected, { ...cookieOpts, httpOnly: true });
  // UI hint cookie: just a marker the client can read to show/hide the AI button.
  response.cookies.set("digest_ok", "1", { ...cookieOpts, httpOnly: false });

  return response;
}
