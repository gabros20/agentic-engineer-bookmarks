import type { Digest } from "@/lib/digest-schema";

// T6 (cross-device sync): the DB is now the single source of truth for saved digests. Digests
// are written server-side on generation (app/api/digest/route.ts onFinish, T5) and read back
// via /api/digests. This module keeps the SHARED SavedDigest shape, a pure DB-row→DTO mapper
// (used by the API route, server-side), and thin async client accessors the panels use. The
// legacy localStorage readers survive only to feed the one-shot migration — they are no longer
// the source of truth. See .orchestrate/task-6-report.md.

const STORAGE_KEY = "agentic-engineer-bookmarks:digests";

// `tldr`/`readFirst`/`deeperReads` are OPTIONAL so OLD saved entries (persisted before the
// digest UI upgrade, JSON with only `themes`+`overall`) still satisfy this type and render
// without a migration step. `id` is present on DB-backed rows (needed to delete) and absent on
// legacy localStorage entries.
export type SavedDigest = {
  id?: string;
  query: string;
  themes: Digest["themes"];
  overall: string;
  tldr?: string;
  readFirst?: Digest["readFirst"];
  deeperReads?: Digest["deeperReads"];
  sourceCount: number;
  createdAt: string;
};

// Minimal view of a `saved_digests` row — kept local so this module (imported by client
// components) doesn't pull the Drizzle schema into the browser bundle.
type SavedDigestRow = {
  id: string;
  query: string;
  content: unknown;
  sourceIds: unknown;
  createdAt: Date | string;
};

// Pure mapper (no `window`) — safe to call server-side in the API route. Flattens the stored
// `content` (a digestSchema object) back into the flat SavedDigest the panels render.
export function rowToSavedDigest(row: SavedDigestRow): SavedDigest {
  const content = (row.content ?? {}) as Partial<Digest> & { sourceCount?: number };
  const createdAt =
    row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  // sourceCount comes from the stored id array (fresh T5 digests). Migrated legacy digests
  // carry no ids, so we fall back to a `sourceCount` stashed in content by the migration.
  const sourceCount = Array.isArray(row.sourceIds)
    ? row.sourceIds.length
    : typeof content.sourceCount === "number"
      ? content.sourceCount
      : 0;
  return {
    id: row.id,
    query: row.query,
    themes: content.themes ?? [],
    overall: content.overall ?? "",
    tldr: content.tldr,
    readFirst: content.readFirst,
    deeperReads: content.deeperReads,
    sourceCount,
    createdAt,
  };
}

export function normalize(query: string) {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

// --- Client accessors (DB-backed, async) --------------------------------------------------

export async function fetchSavedDigests(): Promise<SavedDigest[]> {
  const res = await fetch("/api/digests", { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET /api/digests ${res.status}`);
  const data = (await res.json()) as { digests?: SavedDigest[] };
  return data.digests ?? [];
}

export async function fetchDigestByQuery(query: string): Promise<SavedDigest | null> {
  const res = await fetch(`/api/digests?query=${encodeURIComponent(query)}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { digest?: SavedDigest | null };
  return data.digest ?? null;
}

export async function deleteDigestById(id: string): Promise<void> {
  const res = await fetch(`/api/digests/${encodeURIComponent(id)}`, { method: "DELETE" });
  // Throw on failure so an optimistic UI can roll back + surface an error (T6 M3) rather than
  // silently diverge from the DB (the row would reappear on the next load).
  if (!res.ok) throw new Error(`DELETE /api/digests ${res.status}`);
}

// --- Legacy localStorage reader (migration input only) ------------------------------------

function readLegacy(): Record<string, SavedDigest> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, SavedDigest>) : {};
  } catch {
    return {};
  }
}

/** Legacy localStorage digests — only read to seed the one-shot DB migration (T6). */
export function readLegacyDigests(): SavedDigest[] {
  return Object.values(readLegacy());
}
