import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { aiUsageDaily } from "@/lib/db/schema";

// Authenticated search proxy (T4). ALL search now flows through here: the browser
// (lib/search-client.ts) POSTs same-origin to /api/search, this route checks the Better Auth
// session + a per-user daily search quota, then forwards to the Cloudflare Worker with a
// server-only shared secret (SEARCH_PROXY_SECRET). The Worker rejects anything without that
// secret, so the billable Workers-AI pipeline can no longer be hit directly. Ranking is
// UNCHANGED — this route adds auth + a hop and passes the Worker's { results, phase } through
// verbatim. The real Worker URL and the secret live ONLY on the server (never NEXT_PUBLIC_*).
export const runtime = "nodejs";

// Per-user searches/day. Over this → 429 (the 301st search of a UTC day). Empty/whitespace
// queries short-circuit to [] and do NOT consume quota (they never reach the Worker).
const DAILY_SEARCH_LIMIT = 300;

type SearchBody = {
  query?: unknown;
  precision?: unknown;
  rewrites?: unknown;
  limit?: unknown;
};

export async function POST(request: NextRequest) {
  // 1. Session gate — same DB-backed lookup as app/page.tsx (T3). No session → 401.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: SearchBody;
  try {
    body = (await request.json()) as SearchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { query, precision, rewrites, limit } = body;

  // 2. Empty/whitespace query → empty results, WITHOUT touching quota. Mirrors the Worker's own
  //    empty-query short-circuit so the client contract is unchanged for a cleared search box.
  if (typeof query !== "string" || !query.trim()) {
    return NextResponse.json({ results: [] });
  }

  // 3. Atomic per-user daily quota. One statement: insert today's row at count 1, or increment
  //    the existing count, RETURNING the new value. neon-http has no interactive txn, but a
  //    single INSERT … ON CONFLICT DO UPDATE is atomic server-side, which is sufficient here.
  //    Day boundary = UTC (deterministic on serverless; independent of the function's TZ). The
  //    increment happens before the forward, so a blocked (over-limit) request never reaches the
  //    Worker; a rare Worker/network failure below still consumes one unit of quota (acceptable).
  const day = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const [usage] = await db
    .insert(aiUsageDaily)
    .values({ userId: session.user.id, day, searchCount: 1 })
    .onConflictDoUpdate({
      target: [aiUsageDaily.userId, aiUsageDaily.day],
      set: { searchCount: sql`${aiUsageDaily.searchCount} + 1` },
    })
    .returning({ searchCount: aiUsageDaily.searchCount });

  if (usage.searchCount > DAILY_SEARCH_LIMIT) {
    return NextResponse.json(
      {
        error: "Daily search limit reached. / Elérted a napi keresési limitet.",
        code: "search_quota",
      },
      { status: 429 },
    );
  }

  // 4. Forward to the Worker with the shared secret. The endpoint + secret are server-only.
  const endpoint = process.env.SEARCH_ENDPOINT?.replace(/\/+$/, "");
  const secret = process.env.SEARCH_PROXY_SECRET;
  if (!endpoint || !secret) {
    return NextResponse.json({ error: "search misconfigured" }, { status: 500 });
  }

  try {
    const res = await fetch(`${endpoint}/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Proxy-Secret": secret },
      body: JSON.stringify({ query, precision, rewrites, limit }),
    });
    // Pass the Worker's JSON body + status through unchanged (the client depends on the exact
    // { results, phase } shape). A non-JSON body from the Worker is treated as a bad gateway.
    const data = await res.json().catch(() => null);
    if (data === null) {
      return NextResponse.json({ error: "bad gateway" }, { status: 502 });
    }
    return NextResponse.json(data, { status: res.status });
  } catch {
    // Network error / Worker unreachable → generic 502 (don't leak the endpoint or internals).
    return NextResponse.json({ error: "search upstream failed" }, { status: 502 });
  }
}
