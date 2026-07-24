import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { chatMessages, chatSessions } from "@/lib/db/schema";

// T6: read/delete a single saved chat, scoped to the session user. GET returns the chat WITH
// its ordered messages (to reopen it); DELETE removes the session (chat_messages cascade). The
// user-scoping predicate (`userId = me`) is the security crux — user B can neither read nor
// delete user A's chat.
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  // Fetch the session ONLY if it belongs to the caller — a wrong/other-user id → 404.
  const [row] = await db
    .select()
    .from(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, session.user.id)));
  if (!row) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const msgs = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      parts: chatMessages.parts,
      metadata: chatMessages.metadata,
    })
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, id))
    .orderBy(asc(chatMessages.seq));

  return NextResponse.json({
    chat: {
      id: row.id,
      title: row.title ?? "Untitled chat",
      language: (row.language === "hu" ? "hu" : "en") as "en" | "hu",
      query: row.query ?? null,
      createdAt: row.createdAt.toISOString(),
      // Rebuild UIMessage[] fully (M5): restore `metadata` alongside { id, role, parts } so a
      // reopened chat renders identically. Omit the key entirely when null so useChat sees a
      // clean UIMessage rather than `metadata: null`.
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        parts: m.parts,
        ...(m.metadata != null ? { metadata: m.metadata } : {}),
      })),
    },
  });
}

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
    .delete(chatSessions)
    .where(and(eq(chatSessions.id, id), eq(chatSessions.userId, session.user.id)))
    .returning({ id: chatSessions.id });

  if (deleted.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
