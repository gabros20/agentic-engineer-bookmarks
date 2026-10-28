// Web Worker: fetches and parses the bookmark archive JSON off the main
// thread. JSON.parse for the ~10 MB payload would otherwise freeze
// rendering for hundreds of ms. Rendering data ONLY — since the T4
// cutover the semantic search index lives server-side (the Cloudflare
// search Worker fetches it), so the client never downloads vectors.
//
// Stale-while-revalidate: a cached copy in IndexedDB (lib/archive-cache.ts) is posted first, then
// /api/archive is asked If-None-Match its ETag. 304 → nothing more to do; 200 → post the fresh
// archive (the app simply re-renders with it) and replace the cache.

import { clearArchiveCache, readArchiveCache, writeArchiveCache } from "@/lib/archive-cache";

export type DataWorkerMessage =
  | { type: "bookmarks"; payload: unknown }
  | { type: "error"; which: "bookmarks"; message: string };

type WorkerScope = {
  addEventListener: (event: "message", handler: (e: MessageEvent) => void) => void;
  postMessage: (message: DataWorkerMessage) => void;
};

// A truncated or otherwise broken body must never replace a good cached copy.
function looksLikeArchive(data: unknown): boolean {
  const tweets = (data as { tweets?: unknown } | null)?.tweets;
  return Array.isArray(tweets) && tweets.length > 0;
}

// Guard so this file can be imported as a type from the main thread
// without referencing worker-only globals at module evaluation time.
if (typeof self !== "undefined" && typeof (self as unknown as WorkerScope).postMessage === "function") {
  const ctx = self as unknown as WorkerScope;

  ctx.addEventListener("message", () => {
    // T8: the archive is no longer a public /data/* static asset — it's served by the
    // session-gated /api/archive proxy (→ secret-gated Worker → private R2). Same-origin
    // fetch from this dedicated worker carries the session cookie by default; a logged-out
    // caller gets a 401 (handled as an error below), which the app surfaces like any load failure.
    void load("/api/archive");
  });

  async function load(url: string) {
    const cached = await readArchiveCache();
    if (cached) ctx.postMessage({ type: "bookmarks", payload: cached.payload });
    let unauthorized = false;

    try {
      // no-store keeps the browser's HTTP cache out of it (IndexedDB is the cache), and with an
      // author-set If-None-Match the 304 is handed to us as-is.
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        headers: cached ? { "If-None-Match": cached.etag } : undefined,
      });
      if (response.status === 304) return;
      if (response.status === 401) {
        unauthorized = true;
        await clearArchiveCache();
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      if (!looksLikeArchive(data)) throw new Error("archive payload is empty or malformed");
      ctx.postMessage({ type: "bookmarks", payload: data });
      const etag = response.headers.get("etag");
      if (etag) await writeArchiveCache(etag, data);
    } catch (err) {
      // With a cached copy on screen, a failed refresh is not worth an error banner: the cache is
      // at most one sync behind, and the next load retries. A 401 (session gone) always surfaces.
      if (cached && !unauthorized) return;
      ctx.postMessage({
        type: "error",
        which: "bookmarks",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
