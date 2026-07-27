// Web Worker: fetches and parses the bookmark archive JSON off the main
// thread. JSON.parse for the ~10 MB payload would otherwise freeze
// rendering for hundreds of ms. Rendering data ONLY — since the T4
// cutover the semantic search index lives server-side (the Cloudflare
// search Worker fetches it), so the client never downloads vectors.

export type DataWorkerMessage =
  | { type: "bookmarks"; payload: unknown }
  | { type: "error"; which: "bookmarks"; message: string };

type WorkerScope = {
  addEventListener: (event: "message", handler: (e: MessageEvent) => void) => void;
  postMessage: (message: DataWorkerMessage) => void;
};

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
    try {
      const response = await fetch(url, { credentials: "same-origin" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      ctx.postMessage({ type: "bookmarks", payload: data });
    } catch (err) {
      ctx.postMessage({
        type: "error",
        which: "bookmarks",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
