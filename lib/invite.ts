import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { inviteCodes, pendingSignups } from "@/lib/db/schema";

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

  const codeValid =
    codeRow &&
    codeRow.active &&
    (codeRow.maxUses === null || codeRow.usedCount < codeRow.maxUses);
  if (!codeValid) return { ok: false, status: 400, error: INVALID_CODE };

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
