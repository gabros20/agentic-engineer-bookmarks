// T6 (cross-device sync): saved chats now live in the DB (chat_sessions + chat_messages),
// keyed to the user, so a chat saved on one device shows on another. This module keeps the
// SavedChat shape + id/title helpers, thin async DB accessors the panels/chat use, and a
// legacy localStorage reader that survives only to feed the one-shot migration.

const STORAGE_KEY = "agentic-engineer-bookmarks:chats";

export type SavedChat = {
  id: string;
  title: string;
  language: "en" | "hu";
  /** UIMessage[] from useChat, persisted verbatim (each message's `parts` is stored as jsonb). */
  messages: unknown[];
  /** Optional snapshot of the search context at save time. */
  query: string | null;
  createdAt: string;
};

/** List-row metadata (no messages) — what /api/chats GET returns for the history panel. */
export type SavedChatMeta = Omit<SavedChat, "messages">;

// --- Client accessors (DB-backed, async) --------------------------------------------------

export async function fetchSavedChats(): Promise<SavedChatMeta[]> {
  const res = await fetch("/api/chats", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /api/chats ${res.status}`);
  const data = (await res.json()) as { chats?: SavedChatMeta[] };
  return data.chats ?? [];
}

/** Load one saved chat WITH its ordered messages (to reopen it). */
export async function fetchChat(id: string): Promise<SavedChat | null> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { chat?: SavedChat | null };
  return data.chat ?? null;
}

export async function saveChat(entry: SavedChat): Promise<void> {
  await fetch("/api/chats", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entry),
  });
}

export async function deleteChatById(id: string): Promise<void> {
  const res = await fetch(`/api/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
  // Throw on failure so an optimistic UI can roll back + surface an error (T6 M3) rather than
  // silently diverge from the DB (the row would reappear on the next load).
  if (!res.ok) throw new Error(`DELETE /api/chats ${res.status}`);
}

// --- Legacy localStorage reader (migration input only) ------------------------------------

function readLegacy(): Record<string, SavedChat> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, SavedChat>) : {};
  } catch {
    return {};
  }
}

/** Legacy localStorage chats — only read to seed the one-shot DB migration (T6). */
export function readLegacyChats(): SavedChat[] {
  return Object.values(readLegacy());
}

// --- Pure helpers (unchanged) -------------------------------------------------------------

export function makeChatId() {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function deriveChatTitle(messages: unknown[]): string {
  for (const m of messages) {
    if (typeof m === "object" && m !== null) {
      const msg = m as { role?: string; parts?: Array<{ type?: string; text?: string }>; content?: string };
      if (msg.role === "user") {
        if (Array.isArray(msg.parts)) {
          const text = msg.parts.find((p) => p?.type === "text")?.text;
          if (text) return text.slice(0, 80);
        }
        if (typeof msg.content === "string" && msg.content) return msg.content.slice(0, 80);
      }
    }
  }
  return "Untitled chat";
}
