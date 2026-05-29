import type { Digest } from "@/lib/digest-schema";

const STORAGE_KEY = "agentic-engineer-bookmarks:digests";

export type SavedDigest = {
  query: string;
  themes: Digest["themes"];
  overall: string;
  sourceCount: number;
  createdAt: string;
};

function normalize(query: string) {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

function read(): Record<string, SavedDigest> {
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

function write(all: Record<string, SavedDigest>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // quota exceeded — silently drop
  }
}

export function getDigest(query: string): SavedDigest | null {
  return read()[normalize(query)] ?? null;
}

export function saveDigest(entry: SavedDigest) {
  const all = read();
  all[normalize(entry.query)] = entry;
  write(all);
}

export function deleteDigest(query: string) {
  const all = read();
  delete all[normalize(query)];
  write(all);
}

export function listSavedDigests(): SavedDigest[] {
  return Object.values(read()).sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}
