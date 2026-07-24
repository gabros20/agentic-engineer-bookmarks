import { and, eq, gt, lt, ne, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { inviteCodes, inviteVerifyAttempts, pendingSignups } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Invite domain: the hard gate that decides who may create an account.
// Email is identity; a redeemed invite code is what grants access. A
// `pending_signups` row is the short-lived proof that a code was redeemed for
// a given email, consumed the moment Better Auth creates the user.
// ---------------------------------------------------------------------------

// How long a redeemed code stays valid for completing sign-up.
const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes
// Per-email cooldown between (re)issued reservations — cheap anti-abuse.
const REISSUE_COOLDOWN_MS = 30 * 1000; // 30 seconds

/** Canonical email form used everywhere a `pending_signups` row is keyed. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Seed the owner's existing passkey (DIGEST_UNLOCK_SECRET) as an invite code so
// the owner onboards with a secret they already hold. Idempotent, and cached
// per isolate so we don't issue the upsert on every verify call. On failure the
// cache is cleared so a later call retries.
let seedPromise: Promise<void> | null = null;
export function ensureSeedInvite(): Promise<void> {
  if (!seedPromise) {
    seedPromise = seedInvite().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

async function seedInvite(): Promise<void> {
  const secret = process.env.DIGEST_UNLOCK_SECRET;
  // No secret configured → nothing to seed; verify will simply find no code.
  if (!secret) return;
  await db
    .insert(inviteCodes)
    .values({ id: crypto.randomUUID(), code: secret, label: "seed" })
    .onConflictDoNothing({ target: inviteCodes.code });
}

// ---------------------------------------------------------------------------
// Durable per-IP anti-guessing limiter (T7). Bounds invalid-code guessing ACROSS
// isolates via the `invite_verify_attempts` table (the route also keeps a cheap
// per-isolate in-memory burst limiter in front of this). Only FAILED attempts
// are recorded; a valid code writes nothing, so a legitimate user is never
// blocked. Simple + correct: a sliding 1h window, a fixed threshold.
// ---------------------------------------------------------------------------
const IP_FAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const IP_FAIL_MAX = 10; // failed /invite/verify per IP per hour before we reject

/** True once an IP has exceeded {@link IP_FAIL_MAX} failed attempts in the window. */
export async function isInviteIpBlocked(ip: string): Promise<boolean> {
  const since = new Date(Date.now() - IP_FAIL_WINDOW_MS);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(inviteVerifyAttempts)
    .where(and(eq(inviteVerifyAttempts.ip, ip), gt(inviteVerifyAttempts.createdAt, since)));
  return (row?.count ?? 0) > IP_FAIL_MAX;
}

/**
 * Record one failed (invalid/exhausted-code) verify attempt for `ip`, and prune
 * rows older than the window in the same batch so the table can't grow. Called
 * best-effort by the route — a failure here must never break verify.
 */
export async function recordInviteFailure(ip: string): Promise<void> {
  const cutoff = new Date(Date.now() - IP_FAIL_WINDOW_MS);
  await db.batch([
    db.insert(inviteVerifyAttempts).values({ id: crypto.randomUUID(), ip }),
    db.delete(inviteVerifyAttempts).where(lt(inviteVerifyAttempts.createdAt, cutoff)),
  ]);
}

export type ReserveResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

// Generic, non-leaky failure message: never reveal which check failed.
const INVALID_CODE = "Invalid or exhausted invite code. / Érvénytelen vagy elhasznált meghívókód.";
const TOO_SOON = "Please wait a moment before requesting another link. / Kérjük, várj egy pillanatot az újabb link kérése előtt.";

/**
 * Validate `code` and, on success, reserve a `pending_signups` row for `email`
 * (upsert). Enforces a per-email reissue cooldown. Returns a structured result;
 * the caller maps it to an HTTP response. Never leaks which validation failed.
 */
export async function reserveInvite(rawEmail: string, rawCode: string): Promise<ReserveResult> {
  const email = normalizeEmail(rawEmail);
  const code = rawCode.trim();

  const [codeRow] = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.code, code))
    .limit(1);

  if (!codeRow || !codeRow.active) {
    return { ok: false, status: 400, error: INVALID_CODE };
  }
  // Enforce maxUses against BOTH committed redemptions (usedCount) AND
  // outstanding un-consumed reservations for this code (unexpired
  // pending_signups). Without counting reservations, N emails could each
  // reserve a maxUses=1 code before any consume bumps usedCount, then all sign
  // up and overshoot the limit. Exclude this email's own row so a re-request by
  // the same person never counts against itself (the upsert below replaces it).
  if (codeRow.maxUses !== null) {
    const [{ outstanding }] = await db
      .select({ outstanding: sql<number>`count(*)::int` })
      .from(pendingSignups)
      .where(
        and(
          eq(pendingSignups.codeId, codeRow.id),
          ne(pendingSignups.email, email),
          gt(pendingSignups.expiresAt, new Date()),
        ),
      );
    if (codeRow.usedCount + outstanding >= codeRow.maxUses) {
      return { ok: false, status: 400, error: INVALID_CODE };
    }
  }

  // Per-email cooldown: `createdAt` is refreshed on every reservation below, so
  // it doubles as "last issued at". Reject a burst of repeat requests.
  const [existing] = await db
    .select()
    .from(pendingSignups)
    .where(eq(pendingSignups.email, email))
    .limit(1);
  if (existing && Date.now() - existing.createdAt.getTime() < REISSUE_COOLDOWN_MS) {
    return { ok: false, status: 429, error: TOO_SOON };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PENDING_TTL_MS);
  await db
    .insert(pendingSignups)
    .values({ email, codeId: codeRow.id, expiresAt, createdAt: now })
    .onConflictDoUpdate({
      target: pendingSignups.email,
      set: { codeId: codeRow.id, expiresAt, createdAt: now },
    });

  return { ok: true };
}

/**
 * The gate check used in `user.create.before`: returns the reservation row iff
 * an unexpired `pending_signups` row exists for `email`, else null. A null
 * result MUST abort account creation.
 */
export async function findValidPendingSignup(rawEmail: string) {
  const email = normalizeEmail(rawEmail);
  const [row] = await db
    .select()
    .from(pendingSignups)
    .where(eq(pendingSignups.email, email))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

/**
 * Signup-time re-validation of the reserved code. `findValidPendingSignup` only
 * proves a reservation exists and is unexpired; in the ≤15-min window between
 * reserve and signup the code can be deactivated or exhausted by other
 * redemptions. The gate calls this after the pending lookup succeeds and MUST
 * abort account creation when it returns false. Closes the mid-flight window.
 */
export async function isCodeRedeemable(codeId: string): Promise<boolean> {
  const [code] = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.id, codeId))
    .limit(1);
  if (!code || !code.active) return false;
  if (code.maxUses !== null && code.usedCount >= code.maxUses) return false;
  return true;
}

/**
 * Consume the reservation after a user is successfully created: delete the
 * `pending_signups` row and increment the code's `usedCount`. Runs as a single
 * neon-http batch (server-side transaction) so both land together — neon-http
 * has no interactive `db.transaction()`, but `db.batch()` is transactional.
 */
export async function consumeInvite(rawEmail: string): Promise<void> {
  const email = normalizeEmail(rawEmail);
  const [row] = await db
    .select()
    .from(pendingSignups)
    .where(eq(pendingSignups.email, email))
    .limit(1);
  // Nothing to consume — shouldn't happen post-gate, but stay defensive.
  if (!row) return;
  await db.batch([
    db.delete(pendingSignups).where(eq(pendingSignups.email, email)),
    db
      .update(inviteCodes)
      .set({ usedCount: sql`${inviteCodes.usedCount} + 1` })
      .where(eq(inviteCodes.id, row.codeId)),
  ]);
}
