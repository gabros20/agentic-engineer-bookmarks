import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { aiUsageDaily } from "@/lib/db/schema";

// ---------------------------------------------------------------------------
// Shared API guard (T7). The session gate + atomic per-user daily quota was
// duplicated verbatim across app/api/{search,digest,chat}/route.ts, and the
// quota upsert was unguarded — a transient DB error escaped as a framework 500
// with an internal stack. This module is the single source of truth for both:
//
//   requireUser()                      → the session, or a 401 Response
//   enforceQuota(userId, kind, limit)  → null (proceed), a 429 (over limit),
//                                        or a clean JSON 500 (DB failure)
//
// Behavior is IDENTICAL to the inlined versions it replaces: same limits, same
// 429 codes (search_quota / digest_quota / chat_quota), same UTC day boundary,
// same "increment before the work" ordering (an over-limit request never
// reaches the Worker / OpenRouter). Only robustness improves: the DB write is
// now guarded, so a failed upsert yields a clean 500 instead of leaking.
// ---------------------------------------------------------------------------

type SessionResult = Awaited<ReturnType<typeof auth.api.getSession>>;
type ActiveSession = NonNullable<SessionResult>;

export type RequireUserResult =
  | { ok: true; userId: string; session: ActiveSession }
  | { ok: false; response: NextResponse };

/**
 * Better Auth session gate — the same DB-backed lookup the login wall (T3) and
 * every AI/search route already used. Reads request headers internally so
 * callers don't repeat `headers: await headers()`. On no session returns a
 * ready-to-send 401 Response; callers `if (!gate.ok) return gate.response`.
 */
export async function requireUser(): Promise<RequireUserResult> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  return { ok: true, userId: session.user.id, session };
}

export type QuotaKind = "search" | "digest" | "chat";

// 429 body `code` — the CLIENT keys its localized "daily limit reached" message
// off this (lib/i18n), so it MUST stay stable across the three surfaces.
const QUOTA_CODE: Record<QuotaKind, string> = {
  search: "search_quota",
  digest: "digest_quota",
  chat: "chat_quota",
};

// Non-localized fallback `error` string in the 429 body — a safety net for any
// non-UI caller / logs. The browser ignores it and localizes off `code`.
const QUOTA_MESSAGE: Record<QuotaKind, string> = {
  search: "Daily search limit reached. / Elérted a napi keresési limitet.",
  digest: "Daily digest limit reached. / Elérted a napi összegzési limitet.",
  chat: "Daily chat limit reached. / Elérted a napi csevegési limitet.",
};

/** Thrown when the atomic quota upsert itself fails (DB down / network). */
export class QuotaDbError extends Error {
  constructor(cause?: unknown) {
    super("quota persistence failed");
    this.name = "QuotaDbError";
    if (cause !== undefined) this.cause = cause;
  }
}

// One atomic INSERT … ON CONFLICT DO UPDATE per kind, RETURNING the new count.
// neon-http has no interactive txn, but a single upsert is atomic server-side,
// which is all the quota needs. Split by kind (rather than a computed column
// name) to keep Drizzle's insert types sound under `strict`.
async function incrementQuota(userId: string, kind: QuotaKind, day: string): Promise<number> {
  switch (kind) {
    case "search": {
      const [row] = await db
        .insert(aiUsageDaily)
        .values({ userId, day, searchCount: 1 })
        .onConflictDoUpdate({
          target: [aiUsageDaily.userId, aiUsageDaily.day],
          set: { searchCount: sql`${aiUsageDaily.searchCount} + 1` },
        })
        .returning({ count: aiUsageDaily.searchCount });
      return row.count;
    }
    case "digest": {
      const [row] = await db
        .insert(aiUsageDaily)
        .values({ userId, day, digestCount: 1 })
        .onConflictDoUpdate({
          target: [aiUsageDaily.userId, aiUsageDaily.day],
          set: { digestCount: sql`${aiUsageDaily.digestCount} + 1` },
        })
        .returning({ count: aiUsageDaily.digestCount });
      return row.count;
    }
    case "chat": {
      const [row] = await db
        .insert(aiUsageDaily)
        .values({ userId, day, chatCount: 1 })
        .onConflictDoUpdate({
          target: [aiUsageDaily.userId, aiUsageDaily.day],
          set: { chatCount: sql`${aiUsageDaily.chatCount} + 1` },
        })
        .returning({ count: aiUsageDaily.chatCount });
      return row.count;
    }
  }
}

/**
 * Atomically increment today's counter for `kind` and report whether the caller
 * is still within `limit`. `ok` is `count <= limit` — identical to the inlined
 * `count > LIMIT` reject each route used. Throws {@link QuotaDbError} if the
 * upsert fails (so the caller can return a clean 500 rather than leak a stack).
 */
export async function checkAndIncrementQuota(
  userId: string,
  kind: QuotaKind,
  limit: number,
): Promise<{ ok: boolean; count: number }> {
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  let count: number;
  try {
    count = await incrementQuota(userId, kind, day);
  } catch (err) {
    throw new QuotaDbError(err);
  }
  return { ok: count <= limit, count };
}

/**
 * Run the quota check and return the Response to send when the request must be
 * stopped: a localized-by-client 429 over the limit, or a clean JSON 500 if the
 * DB write failed (never leaking internals). Returns `null` when under limit —
 * the caller proceeds. Collapses the per-route session+quota boilerplate to two
 * lines: `const over = await enforceQuota(...); if (over) return over;`.
 */
export async function enforceQuota(
  userId: string,
  kind: QuotaKind,
  limit: number,
): Promise<NextResponse | null> {
  let result: { ok: boolean; count: number };
  try {
    result = await checkAndIncrementQuota(userId, kind, limit);
  } catch (err) {
    console.error(`[quota] failed to persist ${kind} usage for ${userId}:`, err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
  if (!result.ok) {
    return NextResponse.json({ error: QUOTA_MESSAGE[kind], code: QUOTA_CODE[kind] }, { status: 429 });
  }
  return null;
}
