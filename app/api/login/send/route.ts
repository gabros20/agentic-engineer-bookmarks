import { NextResponse, type NextRequest } from "next/server";

import { auth } from "@/lib/auth";
import { sendMagicLinkEmail } from "@/lib/email";
import { collectSignInEmail } from "@/lib/sign-in-email";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// POST /api/login/send  { email, callbackURL? }
// The login page's "send" step: ONE email with both a magic link (one tap, signs in the
// device that opens it) and a 6-digit code (typed on the device where sign-in started —
// e.g. the computer an MCP client like Claude Code is waiting on, while the email is read
// on a phone). Both come from Better Auth (magicLink + emailOTP); lib/sign-in-email.ts
// collects them so they go out together.
//
// Security is unchanged from calling the two endpoints directly: the send-gate in lib/auth.ts
// (`mayEmail`) emails only an existing user or a valid invite reservation, account creation
// stays invite-gated (`user.create.before`), the callbackURL is validated by Better Auth like
// any magic-link request, and the response never says whether the address is known.
// Throttling: a per-IP burst window plus a per-email cooldown (both per-isolate, best-effort —
// the gate bounds who can receive mail at all).
// ---------------------------------------------------------------------------

const IP_WINDOW_MS = 60_000;
const IP_MAX = 10;
const EMAIL_COOLDOWN_MS = 20_000;
const ipHits = new Map<string, number[]>();
const lastSend = new Map<string, number>();

function throttled(ip: string, email: string): boolean {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 5000) ipHits.clear();
  if (lastSend.size > 5000) lastSend.clear();
  if (hits.length > IP_MAX) return true;
  const previous = lastSend.get(email);
  if (previous !== undefined && now - previous < EMAIL_COOLDOWN_MS) return true;
  lastSend.set(email, now);
  return false;
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: NextRequest) {
  let body: { email?: unknown; callbackURL?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON / Érvénytelen JSON" }, { status: 400 });
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  // Same-origin paths only ("/…", never a protocol-relative "//host"); Better Auth re-validates.
  const raw = typeof body.callbackURL === "string" ? body.callbackURL : "";
  const callbackURL = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
  if (!email || !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "Invalid email / Érvénytelen e-mail-cím" }, { status: 400 });
  }
  if (throttled(clientIp(req), email)) {
    return NextResponse.json({ ok: false, error: "Too many requests. / Túl sok kérés." }, { status: 429 });
  }

  try {
    const parts = await collectSignInEmail(async () => {
      await auth.api.signInMagicLink({ body: { email, callbackURL }, headers: req.headers });
      await auth.api.sendVerificationOTP({ body: { email, type: "sign-in" }, headers: req.headers });
    });
    // Nothing collected = the send-gate skipped this address (unknown, not invited) or the test
    // sink took it. Same response either way: never reveal whether an email is known.
    if (parts.url || parts.otp) await sendMagicLinkEmail({ email, url: parts.url, otp: parts.otp });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[login] send failed", err);
    return NextResponse.json({ ok: false, error: "Could not send the email. / Nem sikerült elküldeni az e-mailt." }, { status: 500 });
  }
}
