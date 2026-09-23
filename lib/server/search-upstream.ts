// ---------------------------------------------------------------------------
// Server-to-Worker plumbing, shared by the session-gated /api/search route and
// the server-side query layer behind the MCP server (lib/server/bookmark-
// service.ts). The Worker is fail-closed on SEARCH_PROXY_SECRET, so every
// caller forwards the same server-only secret; the endpoint + secret never
// reach the browser (never NEXT_PUBLIC_*).
// ---------------------------------------------------------------------------

export type WorkerConfig = { endpoint: string; secret: string };

/** The Worker URL (trailing slashes stripped) + proxy secret, or null if either is unset. */
export function getWorkerConfig(): WorkerConfig | null {
  const endpoint = process.env.SEARCH_ENDPOINT?.replace(/\/+$/, "");
  const secret = process.env.SEARCH_PROXY_SECRET;
  if (!endpoint || !secret) return null;
  return { endpoint, secret };
}

// Hard ceiling on the proxy→Worker search round trip. Without it, a hung Worker (connected but
// silent isolate, network black hole) would hold the Vercel function open to its maxDuration.
export const WORKER_SEARCH_TIMEOUT_MS = 12000;

export type WorkerSearchBody = {
  query: unknown;
  precision: unknown;
  rewrites?: unknown;
  limit?: unknown;
};

/**
 * POST the body to the Worker's /search. Resolves with the Worker's status + parsed JSON body
 * (`data: null` when the body is not JSON); REJECTS on network error, timeout, or `signal` abort.
 * Callers own the HTTP mapping (the /api/search route passes both through verbatim).
 */
export async function forwardWorkerSearch(
  config: WorkerConfig,
  body: WorkerSearchBody,
  signal?: AbortSignal,
): Promise<{ status: number; data: unknown }> {
  const timeout = AbortSignal.timeout(WORKER_SEARCH_TIMEOUT_MS);
  const res = await fetch(`${config.endpoint}/search`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Proxy-Secret": config.secret },
    body: JSON.stringify(body),
    // Compose the timeout with the caller's signal so an abandoned request actually cancels the
    // billable Workers-AI call upstream instead of running to the ceiling.
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/** Parse a Worker /search body into ranked `{ id, score }` rows (null if the shape is wrong). */
export function parseRankedResults(data: unknown): Array<{ id: string; score: number }> | null {
  if (!data || typeof data !== "object" || !Array.isArray((data as { results?: unknown }).results)) return null;
  return ((data as { results: unknown[] }).results).filter(
    (r): r is { id: string; score: number } =>
      Boolean(r) &&
      typeof (r as { id?: unknown }).id === "string" &&
      typeof (r as { score?: unknown }).score === "number",
  );
}
