import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { savedDigests } from "@/lib/db/schema";

// T6: delete one saved digest, scoped to the session user. The `and(id, userId)` predicate is
// the security crux — user B deleting `/api/digests/<A's id>` matches zero rows (no-op), so a
// user can never delete another user's digest.
export const runtime = "nodejs";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const deleted = await db
    .delete(savedDigests)
    .where(and(eq(savedDigests.id, id), eq(savedDigests.userId, session.user.id)))
    .returning({ id: savedDigests.id });

  // 404 when nothing matched (wrong id, or another user's row) — never reveals whether the id
  // exists under a different user.
  if (deleted.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
