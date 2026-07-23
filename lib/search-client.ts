// Shared client for the Cloudflare search Worker (Task 4). ONE fetch wrapper used by
// both the live search effect and the ⌘K chat's search tool (runChatSearch) in
// components/bookmarks-app.tsx, so request/response shape and error handling live in a
// single place. This is the entire client-side "search engine" after the cutover: no
// embeddings, no vector math, no rerank — the Worker owns all of that.
//
// Contract (frozen in .orchestrate/run.md, served by worker/src/index.ts):
//   POST {SEARCH_ENDPOINT}/search  { query, precision, rewrites?, limit? }
//        -> { results: [{ id, score }], phase?: "reranked" }
// Non-2xx / malformed responses throw; callers fall back to a cheap client-side
// substring filter over already-loaded posts (never re-run any ML on the client).

import type { SearchPrecision } from "@/lib/bookmark-search";

// Deployed Worker URL is injected at build time by Vercel (T5); dev defaults to a local
// `wrangler dev` on :8787. Trailing slash trimmed so `${endpoint}/search` is always clean.
const SEARCH_ENDPOINT = (process.env.NEXT_PUBLIC_SEARCH_ENDPOINT ?? "http://localhost:8787").replace(/\/+$/, "");

// Hard ceiling on a single /search round trip. Without it, a connected-but-silent Worker
// (hung isolate, network black hole) would leave the UI stuck in "searching…" forever, since
// only a query change or unmount aborts the in-flight fetch. On timeout the request aborts
// and surfaces as an error, so the caller degrades to the substring fallback like any other
// failure. Generous enough for a cold-isolate first request (model + ~22MB data load).
const SEARCH_TIMEOUT_MS = 12000;

export type RankedResult = { id: string; score: number };

export type SearchRequest = {
  query: string;
  precision: SearchPrecision;
  // LLM query rewrites from /api/expand (broad + unlocked only); merged with the Worker's
  // own static synonym expansions server-side. Empty/omitted is a valid, common case.
  rewrites?: string[];
  limit?: number;
  signal?: AbortSignal;
};

/**
 * POST the query to the Worker's /search and return the ranked `{ id, score }` list — the
 * exact shape the component's `hybridResults` Map already consumes. Throws on network
 * error, non-2xx, or a malformed body (including an aborted request, which surfaces as an
 * AbortError); callers guard on cancellation and degrade to a substring filter otherwise.
 */
export async function searchViaWorker(request: SearchRequest): Promise<RankedResult[]> {
  const { query, precision, rewrites, limit, signal } = request;
  // Combine the caller's cancellation signal (query change / unmount) with a timeout, so a
  // hung request can never wedge the UI in "searching…". AbortSignal.any is supported in all
  // browsers this app targets (Next 16 / modern evergreen); the timeout signal is GC'd with
  // the request.
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${SEARCH_ENDPOINT}/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, precision, rewrites, limit }),
    signal: combinedSignal,
  });
  if (!response.ok) throw new Error(`search request failed: ${response.status}`);

  const data: unknown = await response.json();
  const results =
    data && typeof data === "object" && "results" in data && Array.isArray((data as { results: unknown }).results)
      ? (data as { results: unknown[] }).results
      : null;
  if (!results) throw new Error("search response missing results[]");

  return results.filter(
    (r): r is RankedResult =>
      Boolean(r) && typeof (r as RankedResult).id === "string" && typeof (r as RankedResult).score === "number",
  );
}
