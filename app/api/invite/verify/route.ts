import { NextResponse, type NextRequest } from "next/server";

import {
  ensureSeedInvite,
  isInviteIpBlocked,
  recordInviteFailure,
  reserveInvite,
} from "@/lib/invite";

export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// POST /api/invite/verify  { code, email }
// Validates an invite code and reserves a short-lived `pending_signups` row for
// the email. This is step 1 of the gate: the client (T3) then requests a magic
// link, and account creation only succeeds while this reservation is unexpired.
//
// Rate limiting (lightweight, documented):
//  - Per-email: a 30s reissue cooldown enforced in reserveInvite via the
//    reservation's createdAt (durable, DB-backed).
//  - Per-IP burst: a coarse in-memory sliding window (below). Best-effort only
//    — it is per-isolate and resets on cold start; it blunts rapid bursts.
//  - Per-IP durable (T7): failed (invalid/exhausted-code) attempts are counted
//    across isolates in `invite_verify_attempts`; >10 per IP per hour → 429.
//    This is the cross-isolate anti-guessing bound the in-memory limiter can't
//    give. The hard gate is still the code itself + the per-email cooldown.
// ---------------------------------------------------------------------------

const IP_WINDOW_MS = 60 * 1000; // 1 minute
const IP_MAX = 20; // requests per window per IP
const ipHits = new Map<string, number[]>();

function ipRateLimited(ip: string): boolean {
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS);
  hits.push(now);
  ipHits.set(ip, hits);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (ipHits.size > 5000) {
    for (const [key, times] of ipHits) {
      if (times.every((t) => now - t >= IP_WINDOW_MS)) ipHits.delete(key);
    }
  }
  return hits.length > IP_MAX;
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  // Cheap per-isolate burst check first (no DB hit), then the durable cross-isolate bound.
  // F2: FAIL-OPEN on the durable read — a transient Neon error must never turn an otherwise-valid
  // invite verify (incl. a legitimate login) into a framework 500. On read failure we simply skip
  // the durable bound (the per-isolate burst limiter + the code itself + the per-email cooldown
  // still stand). Mirrors the best-effort guard already around recordInviteFailure below.
  let durablyBlocked = false;
  try {
    durablyBlocked = await isInviteIpBlocked(ip);
  } catch (err) {
    console.error("[invite] isInviteIpBlocked read failed; failing open:", err);
  }
  if (ipRateLimited(ip) || durablyBlocked) {
    return NextResponse.json(
      { ok: false, error: "Too many requests. / Túl sok kérés." },
      { status: 429 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON / Érvénytelen JSON" },
      { status: 400 },
    );
  }

  const { code, email } = (body ?? {}) as { code?: unknown; email?: unknown };
  if (typeof code !== "string" || typeof email !== "string" || !code.trim() || !email.trim()) {
    return NextResponse.json(
      { ok: false, error: "Both code and email are required. / A kód és az e-mail is kötelező." },
      { status: 400 },
    );
  }

  // Ensure the owner's seed invite exists (idempotent, cached per isolate).
  await ensureSeedInvite();

  const result = await reserveInvite(email, code);
  if (!result.ok) {
    // Record a durable failure ONLY for an invalid/exhausted-code guess (status 400) — the signal
    // we bound. The per-email 30s cooldown (429) is a legitimate user retrying, not a guess.
    // Best-effort: a limiter write must never turn a 400 into a 500.
    if (result.status === 400) {
      try {
        await recordInviteFailure(ip);
      } catch (err) {
        console.error("[invite] failed to record verify failure:", err);
      }
    }
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true });
}
