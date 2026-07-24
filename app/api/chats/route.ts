import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { chatMessages, chatSessions } from "@/lib/db/schema";

// T6 (cross-device sync): saved chats. GET lists the session user's chats (metadata only);
// POST upserts one chat (session row + its message rows) by id, so re-saving a growing
// conversation UPDATES it rather than duplicating. All access is user-scoped — a POST that
// targets an id owned by another user is rejected (403), never silently overwritten.
export const runtime = "nodejs";

export async function GET() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const rows = await db
    .select({
      id: chatSessions.id,
      title: chatSessions.title,
      language: chatSessions.language,
      query: chatSessions.query,
      createdAt: chatSessions.createdAt,
    })
    .from(chatSessions)
    .where(eq(chatSessions.userId, session.user.id))
    .orderBy(desc(chatSessions.createdAt));

  const chats = rows.map((r) => ({
    id: r.id,
    title: r.title ?? "Untitled chat",
    language: (r.language === "hu" ? "hu" : "en") as "en" | "hu",
    query: r.query ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
  return NextResponse.json({ chats });
}

type SaveChatBody = {
  id?: unknown;
  title?: unknown;
  language?: unknown;
  query?: unknown;
  createdAt?: unknown;
  messages?: unknown;
};

type IncomingMessage = { id?: unknown; role?: unknown; parts?: unknown };

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: SaveChatBody;
  try {
    body = (await request.json()) as SaveChatBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const id = typeof body.id === "string" && body.id ? body.id : null;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  if (!Array.isArray(body.messages)) {
    return NextResponse.json({ error: "messages must be an array" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title : "Untitled chat";
  const language = body.language === "hu" ? "hu" : "en";
  const query = typeof body.query === "string" ? body.query : null;

  // Security: if this id already exists, it MUST belong to the caller. A collision with
  // another user's id (astronomically unlikely for c_… ids, but enforced anyway) is rejected —
  // we never overwrite or leak another user's chat.
  const [existing] = await db
    .select({ userId: chatSessions.userId })
    .from(chatSessions)
    .where(eq(chatSessions.id, id));
  if (existing && existing.userId !== userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (existing) {
    await db
      .update(chatSessions)
      .set({ title, language, query })
      .where(eq(chatSessions.id, id));
  } else {
    await db.insert(chatSessions).values({ id, userId, title, language, query });
  }

  // Replace the message set wholesale — the client sends the full conversation each save, so
  // deleting + re-inserting keeps seq contiguous and reflects the grown conversation exactly.
  // M1 fix: run the delete+reinsert as ONE neon-http batch (server-side transaction, same
  // pattern as lib/invite.ts consumeInvite) so it's all-or-nothing — a failure between the
  // delete and the insert can no longer wipe the messages and leave the chat empty.
  const rows = (body.messages as IncomingMessage[]).map((m, seq) => ({
    id: typeof m.id === "string" && m.id ? m.id : crypto.randomUUID(),
    sessionId: id,
    seq,
    role: typeof m.role === "string" ? m.role : "assistant",
    parts: (Array.isArray(m.parts) ? m.parts : []) as unknown,
  }));
  if (rows.length > 0) {
    await db.batch([
      db.delete(chatMessages).where(eq(chatMessages.sessionId, id)),
      db.insert(chatMessages).values(rows),
    ]);
  } else {
    // No messages to insert → the delete alone is a single atomic statement.
    await db.delete(chatMessages).where(eq(chatMessages.sessionId, id));
  }

  return NextResponse.json({ ok: true, id });
}
