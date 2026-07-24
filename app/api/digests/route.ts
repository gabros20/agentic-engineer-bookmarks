import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { savedDigests } from "@/lib/db/schema";
import { rowToSavedDigest } from "@/lib/digest-cache";

// T6 (cross-device sync): read side for saved digests. Digests are WRITTEN server-side by
// app/api/digest/route.ts's onFinish (T5) — this route lists / looks-them-up so the panels
// and the "already generated?" check read from the DB (single source of truth), not
// per-device localStorage. Every query is scoped to the session user: a user only ever sees
// their OWN rows. Delete lives in ./[id]/route.ts.
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  // Session gate — same DB-backed lookup as /api/search (T4). No session → 401.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  // Every generation appends a row (T5), so the same query can have several rows. We collapse
  // to newest-per-normalized-query so the panel shows one card per query (the pre-T6 UX) and
  // the ?query= lookup returns the most recent digest for that query.
  const rows = await db
    .select()
    .from(savedDigests)
    .where(eq(savedDigests.userId, userId))
    .orderBy(desc(savedDigests.createdAt));

  const queryParam = request.nextUrl.searchParams.get("query");
  if (queryParam !== null) {
    // ?query= → most recent digest matching the normalized query (or null). Powers the
    // digest panel's "show the previously-generated digest instead of regenerating" path.
    const target = normalize(queryParam);
    const hit = rows.find((r) => normalize(r.query) === target);
    return NextResponse.json({ digest: hit ? rowToSavedDigest(hit) : null });
  }

  const seen = new Set<string>();
  const digests = [];
  for (const row of rows) {
    const key = normalize(row.query);
    if (seen.has(key)) continue;
    seen.add(key);
    digests.push(rowToSavedDigest(row));
  }
  return NextResponse.json({ digests });
}

// Kept in sync with lib/digest-cache.ts's normalize — the cache key semantics must match so a
// ?query= lookup finds the row a client saved/generated under the same displayed query string.
function normalize(query: string) {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}
