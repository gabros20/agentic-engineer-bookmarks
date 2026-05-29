// Web Worker: fetches and parses the bookmark + semantic index JSON
// off the main thread. JSON.parse for the bookmark archive (~10 MB)
// would otherwise freeze rendering for hundreds of ms.

export type DataWorkerMessage =
  | { type: "bookmarks"; payload: unknown }
  | { type: "searchIndex"; payload: unknown }
  | { type: "error"; which: "bookmarks" | "searchIndex"; message: string };

type WorkerScope = {
  addEventListener: (event: "message", handler: (e: MessageEvent) => void) => void;
  postMessage: (message: DataWorkerMessage) => void;
};

// Guard so this file can be imported as a type from the main thread
// without referencing worker-only globals at module evaluation time.
if (typeof self !== "undefined" && typeof (self as unknown as WorkerScope).postMessage === "function") {
  const ctx = self as unknown as WorkerScope;

  ctx.addEventListener("message", () => {
    void load("/data/all-bookmarks.json", "bookmarks");
    void load("/data/search-index.json", "searchIndex");
  });

  async function load(url: string, which: "bookmarks" | "searchIndex") {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      ctx.postMessage({ type: which, payload: data });
    } catch (err) {
      ctx.postMessage({
        type: "error",
        which,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
