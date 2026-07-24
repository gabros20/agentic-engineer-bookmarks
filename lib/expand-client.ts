// Client-safe helper for the session-gated LLM query-expansion route
// (app/api/expand/route.ts; the passkey is retired). Plain module — no "use client" needed, it holds
// no component state, just a module-level cache (mirrors lib/digest-cache.ts's
// normalize-key convention) and a fetch wrapper.
//
// Hard non-blocking-failure contract: fetchQueryRewrites NEVER throws and NEVER
// hangs the caller past REWRITE_TIMEOUT_MS — on any failure (network error,
// non-OK response, invalid response shape, timeout, or caller-signalled abort)
// it resolves to []. Callers merge that into an existing expansion list, so an
// empty array is exactly "proceed as if this call never happened."

export const REWRITE_TIMEOUT_MS = 1500;

const CACHE_MAX_ENTRIES = 50;
const cache = new Map<string, string[]>();

function normalize(query: string) {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

// F3 note: the route no longer reads `language` into its prompt (UI locale != query-text
// language, see app/api/expand/route.ts), so keying the cache on it is no longer necessary
// for correctness — but it's harmless to keep: worst case is a few extra cache misses if a
// bilingual user toggles UI language between identical searches, not a correctness bug, and
// changing the key shape isn't worth the churn in this fix wave.
function cacheKey(language: "en" | "hu", query: string) {
  return `${language}:${normalize(query)}`;
}

function rememberInCache(key: string, rewrites: string[]) {
  // Map preserves insertion order; re-setting an existing key doesn't reorder
  // it unless we delete first, so delete-then-set both refreshes recency and
  // keeps the oldest entry as `.next().value` for drop-oldest eviction below.
  cache.delete(key);
  cache.set(key, rewrites);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
}

/**
 * Fetch up to 3 LLM-generated query rewrites from /api/expand. Returns [] on
 * ANY failure — non-OK response, network error, invalid response shape, the
 * internal REWRITE_TIMEOUT_MS timeout, or the caller's own `signal` aborting.
 * No retries (route cost containment, per brief). Results are cached
 * in-memory per `${language}:${normalizedQuery}`, capped at ~50 entries with
 * drop-oldest eviction.
 */
export async function fetchQueryRewrites(
  query: string,
  language: "en" | "hu",
  signal?: AbortSignal,
): Promise<string[]> {
  // F2 cheap guard: below this length a rewrite call is almost certainly mid-keystroke
  // noise (single letters, a stray character surviving the debounce). Chosen here — the
  // one call site that reaches the paid route — rather than in the caller, so every future
  // caller of fetchQueryRewrites inherits the guard for free.
  if (query.trim().length < 3) return [];

  const key = cacheKey(language, query);
  const cached = cache.get(key);
  if (cached) return cached;

  if (signal?.aborted) return [];

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), REWRITE_TIMEOUT_MS);
  const onCallerAbort = () => timeoutController.abort();
  signal?.addEventListener("abort", onCallerAbort);

  try {
    const response = await fetch("/api/expand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, language }),
      signal: timeoutController.signal,
    });
    if (!response.ok) return [];

    const data: unknown = await response.json();
    const rewrites =
      data && typeof data === "object" && "rewrites" in data && Array.isArray((data as { rewrites: unknown }).rewrites)
        ? (data as { rewrites: unknown[] }).rewrites.filter((r): r is string => typeof r === "string")
        : null;
    if (!rewrites) return [];

    rememberInCache(key, rewrites);
    return rewrites;
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}
