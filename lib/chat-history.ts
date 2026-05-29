// localStorage-backed history for explicitly-saved chats. Mirrors
// lib/digest-cache.ts in shape.

const STORAGE_KEY = "agentic-engineer-bookmarks:chats";

export type SavedChat = {
  id: string;
  title: string;
  language: "en" | "hu";
  /** UIMessage[] from useChat, serialized as-is */
  messages: unknown[];
  /** Optional snapshot of the search context at save time */
  query: string | null;
  createdAt: string;
};

function read(): Record<string, SavedChat> {
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

function write(all: Record<string, SavedChat>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // quota / serialization — silently drop
  }
}

export function saveChat(entry: SavedChat) {
  const all = read();
  all[entry.id] = entry;
  write(all);
}

export function deleteChat(id: string) {
  const all = read();
  delete all[id];
  write(all);
}

export function getChat(id: string): SavedChat | null {
  return read()[id] ?? null;
}

export function listSavedChats(): SavedChat[] {
  return Object.values(read()).sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}

export function makeChatId() {
  // localStorage-only — collision risk is negligible.
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
