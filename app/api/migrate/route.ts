import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { chatMessages, chatSessions, savedDigests } from "@/lib/db/schema";
import { normalize, type SavedDigest } from "@/lib/digest-cache";
import type { SavedChat } from "@/lib/chat-history";

// T6 (cross-device sync): one-shot import of a user's pre-T6 localStorage digests + chats into
// the DB. Idempotent + non-destructive: it only INSERTS rows the user doesn't already have
// (digests deduped by normalized-query+createdAt, chats by id) and never touches localStorage.
// Everything is scoped to the session user. Safe to call repeatedly — a second call inserts
// nothing.
export const runtime = "nodejs";

type MigrateBody = { digests?: unknown; chats?: unknown };

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;

  let body: MigrateBody;
  try {
    body = (await request.json()) as MigrateBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const digests = Array.isArray(body.digests) ? (body.digests as SavedDigest[]) : [];
  const chats = Array.isArray(body.chats) ? (body.chats as SavedChat[]) : [];

  let digestsInserted = 0;
  let chatsInserted = 0;

  // --- Digests: dedupe by (normalized query + createdAt) among the user's existing rows ---
  if (digests.length > 0) {
    const existing = await db
      .select({ query: savedDigests.query, createdAt: savedDigests.createdAt })
      .from(savedDigests)
      .where(eq(savedDigests.userId, userId));
    const seen = new Set(
      existing.map((r) => `${normalize(r.query)}::${r.createdAt.toISOString()}`),
    );
    for (const d of digests) {
      if (!d || typeof d.query !== "string") continue;
      const createdAt = d.createdAt ? new Date(d.createdAt) : new Date();
      const key = `${normalize(d.query)}::${createdAt.toISOString()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Reconstruct the digestSchema `content`; stash sourceCount so the DTO can recover it
      // (migrated legacy digests carry no source-id array).
      await db.insert(savedDigests).values({
        id: crypto.randomUUID(),
        userId,
        title: d.query,
        query: d.query,
        precision: null,
        content: {
          tldr: d.tldr,
          overall: d.overall,
          themes: d.themes ?? [],
          readFirst: d.readFirst,
          deeperReads: d.deeperReads,
          sourceCount: typeof d.sourceCount === "number" ? d.sourceCount : 0,
        },
        sourceIds: null,
        language: null,
        createdAt,
      });
      digestsInserted++;
    }
  }

  // --- Chats: dedupe by id (skip any id already present, even another user's) ---------------
  for (const c of chats) {
    if (!c || typeof c.id !== "string" || !c.id) continue;
    const [present] = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.id, c.id));
    if (present) continue; // already migrated (or id taken) — non-destructive skip
    const language = c.language === "hu" ? "hu" : "en";
    await db.insert(chatSessions).values({
      id: c.id,
      userId,
      title: c.title ?? "Untitled chat",
      language,
      query: typeof c.query === "string" ? c.query : null,
      createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
    });
    const messages = Array.isArray(c.messages) ? c.messages : [];
    const rows = messages.map((m, seq) => {
      const msg = (m ?? {}) as { id?: unknown; role?: unknown; parts?: unknown };
      return {
        id: typeof msg.id === "string" && msg.id ? msg.id : crypto.randomUUID(),
        sessionId: c.id,
        seq,
        role: typeof msg.role === "string" ? msg.role : "assistant",
        parts: (Array.isArray(msg.parts) ? msg.parts : []) as unknown,
      };
    });
    if (rows.length > 0) {
      await db.insert(chatMessages).values(rows);
    }
    chatsInserted++;
  }

  return NextResponse.json({ ok: true, digestsInserted, chatsInserted });
}
