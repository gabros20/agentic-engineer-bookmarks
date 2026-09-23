import { DAILY_SEARCH_LIMIT, QuotaDbError, checkAndIncrementQuota } from "@/lib/api-guard";
import type { SearchPrecision } from "@/lib/bookmark-search";
import {
  type ContentFilter,
  hasActiveOperators,
  matchesContentFilter,
  matchesOperators,
  postTime,
  searchable,
  toBookmarkDetail,
  toSearchHit,
} from "@/lib/bookmark-filters";
import type { BookmarkPost } from "@/lib/bookmark-types";
import { parseQueryOperators } from "@/lib/query-operators";
import { generateQueryRewrites } from "@/lib/server/query-expand";
import { forwardWorkerSearch, getWorkerConfig, parseRankedResults } from "@/lib/server/search-upstream";
import { normalizeBookmarkPayload } from "@/lib/xrelay-archive";

// ---------------------------------------------------------------------------
// Server-side bookmark query layer — the web UI's search capabilities WITHOUT a
// browser. The UI gets bare ranked ids from the Worker and hydrates/filters them
// against the archive it already downloaded; a server caller (the MCP server,
// app/api/mcp) has no such archive, so this module:
//
//   1. loads + caches the archive server-side (Worker GET /archive → R2, the same
//      secret-gated path /api/archive streams to the browser), per function
//      instance with a short TTL so a fresh `npm run sync` shows up within minutes;
//   2. applies the SAME query semantics as the UI: `from:`/`before:`/`after:`
//      operators (lib/query-operators), the content-type filter, optional LLM
//      rewrites for broad search (lib/server/query-expand), and the shared filter
//      helpers (lib/bookmark-filters) — ranking itself stays in the Worker;
//   3. meters every Worker-bound search against the user's SAME daily search quota
//      as the web UI (DAILY_SEARCH_LIMIT). Operator-only listings and get_bookmark
//      never touch the Worker and cost no quota — mirroring the UI, where an
//      operators-only query never reaches the Worker either.
//
// No Worker change: ranking is byte-identical to the web UI's.
// ---------------------------------------------------------------------------

// ============================== Archive cache ==============================

const ARCHIVE_TTL_MS = 5 * 60 * 1000;
const ARCHIVE_TIMEOUT_MS = 20000;

type ArchiveSnapshot = {
  posts: BookmarkPost[];
  byId: Map<string, BookmarkPost>;
  loadedAt: number;
};

let archive: ArchiveSnapshot | null = null;
let archiveLoad: Promise<ArchiveSnapshot> | null = null;

export class BookmarkServiceError extends Error {
  constructor(
    message: string,
    readonly code: "misconfigured" | "archive_unavailable" | "search_quota" | "quota_db" | "invalid_query",
  ) {
    super(message);
    this.name = "BookmarkServiceError";
  }
}

async function fetchArchive(): Promise<ArchiveSnapshot> {
  const worker = getWorkerConfig();
  if (!worker) throw new BookmarkServiceError("search misconfigured", "misconfigured");
  const res = await fetch(`${worker.endpoint}/archive`, {
    headers: { "X-Proxy-Secret": worker.secret },
    signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
  });
  if (!res.ok) throw new BookmarkServiceError(`archive upstream ${res.status}`, "archive_unavailable");
  const posts = normalizeBookmarkPayload(await res.json());
  if (!posts.length) throw new BookmarkServiceError("archive empty", "archive_unavailable");
  return { posts, byId: new Map(posts.map((p) => [p.id, p])), loadedAt: Date.now() };
}

/**
 * The archive, cached per function instance (Fluid Compute reuses instances, so most calls are
 * warm). Past the TTL a refresh is attempted; if it FAILS while a stale copy exists, the stale copy
 * is served (a transient R2/Worker blip must not break search that was working a minute ago).
 * Concurrent callers share one in-flight load; a failed load is not memoized.
 */
export async function loadArchive(): Promise<ArchiveSnapshot> {
  if (archive && Date.now() - archive.loadedAt < ARCHIVE_TTL_MS) return archive;
  if (!archiveLoad) {
    archiveLoad = fetchArchive()
      .then((snapshot) => {
        archive = snapshot;
        return snapshot;
      })
      .finally(() => {
        archiveLoad = null;
      });
  }
  try {
    return await archiveLoad;
  } catch (err) {
    if (archive) {
      console.error("[bookmark-service] archive refresh failed; serving stale copy:", err);
      return archive;
    }
    throw err instanceof BookmarkServiceError
      ? err
      : new BookmarkServiceError("archive unavailable", "archive_unavailable");
  }
}

// ================================= Search =================================

// Rewrites are an optional recall boost, never a blocker: the same budget the browser gives
// /api/expand (lib/expand-client REWRITE_TIMEOUT_MS) and the same ≥3-char guard.
const REWRITE_TIMEOUT_MS = 1500;

// Ask the Worker for its full default candidate pool (DEFAULT_LIMIT = 240), NOT the caller's
// limit: operator + content filters run AFTER ranking here, so a small upstream limit would starve
// a filtered request (same reasoning as the ⌘K chat's runChatSearch).
const WORKER_CANDIDATE_LIMIT = 240;

export type SearchInput = {
  query: string;
  precision: SearchPrecision;
  limit: number;
  filter?: ContentFilter;
  /** Explicit operators; appended to `query` as tokens, so they win over inline ones (last-wins). */
  from?: string;
  after?: string;
  before?: string;
  /** LLM query rewrites for broad search (the web UI always does this in broad mode). */
  expand?: boolean;
};

export type SearchHit = ReturnType<typeof toSearchHit> & { score?: number };

export type SearchOutput = {
  query: string;
  precision: SearchPrecision;
  mode: "ranked" | "operators-only" | "substring-fallback";
  operators: { from?: string; after?: string; before?: string };
  warnings: string[];
  totalMatches: number;
  count: number;
  archiveSize: number;
  results: SearchHit[];
};

function isoDay(date: Date | undefined): string | undefined {
  return date ? date.toISOString().slice(0, 10) : undefined;
}

/** Rewrites with a hard timeout; [] on any failure (never fails the search). */
async function rewritesFor(query: string, signal?: AbortSignal): Promise<string[]> {
  if (query.trim().length < 3 || !process.env.OPENROUTER_API_KEY) return [];
  const timeout = AbortSignal.timeout(REWRITE_TIMEOUT_MS);
  try {
    return await generateQueryRewrites(query, signal ? AbortSignal.any([signal, timeout]) : timeout);
  } catch {
    return [];
  }
}

/**
 * Hybrid search over the archive with the web UI's semantics. `userId` is metered against the
 * shared daily search quota for Worker-bound searches only. Throws BookmarkServiceError for
 * quota/config/archive failures; a Worker outage degrades to a substring match (like the UI).
 */
export async function searchBookmarks(
  input: SearchInput,
  ctx: { userId: string; signal?: AbortSignal },
): Promise<SearchOutput> {
  const explicit = [
    input.from ? `from:${input.from}` : "",
    input.after ? `after:${input.after}` : "",
    input.before ? `before:${input.before}` : "",
  ].filter(Boolean);
  const { text, operators } = parseQueryOperators([input.query, ...explicit].join(" "));
  const warnings = operators.invalid.map(
    (entry) => `Ignored invalid operator "${entry.token}" (${entry.reason === "bad-date" ? "use YYYY-MM or YYYY-MM-DD" : "not a valid X handle"}).`,
  );
  const appliedOperators = { from: operators.from, after: isoDay(operators.after), before: isoDay(operators.before) };

  if (!text && !hasActiveOperators(operators)) {
    throw new BookmarkServiceError("Provide a search query and/or a from/after/before filter.", "invalid_query");
  }

  const { posts, byId } = await loadArchive();
  const passes = (post: BookmarkPost) => matchesOperators(post, operators) && matchesContentFilter(post, input.filter);
  const base = {
    query: text,
    precision: input.precision,
    operators: appliedOperators,
    warnings,
    archiveSize: posts.length,
  };

  // Operators-only: a filtered listing, newest first. No Worker call → no quota (UI parity).
  if (!text) {
    const matched = posts.filter(passes).sort((a, b) => postTime(b) - postTime(a));
    const top = matched.slice(0, input.limit);
    return { ...base, mode: "operators-only", totalMatches: matched.length, count: top.length, results: top.map(toSearchHit) };
  }

  const worker = getWorkerConfig();
  if (!worker) throw new BookmarkServiceError("search misconfigured", "misconfigured");

  // Meter BEFORE the billable call, exactly like /api/search (over-limit never reaches the Worker).
  let quota: { ok: boolean };
  try {
    quota = await checkAndIncrementQuota(ctx.userId, "search", DAILY_SEARCH_LIMIT);
  } catch (err) {
    if (err instanceof QuotaDbError) {
      console.error(`[bookmark-service] failed to persist search usage for ${ctx.userId}:`, err);
      throw new BookmarkServiceError("internal error", "quota_db");
    }
    throw err;
  }
  if (!quota.ok) {
    throw new BookmarkServiceError(
      `Daily search limit reached (${DAILY_SEARCH_LIMIT}/day, resets at 00:00 UTC).`,
      "search_quota",
    );
  }

  const rewrites = input.precision === "broad" && input.expand !== false ? await rewritesFor(text, ctx.signal) : [];

  let ranked: Array<{ id: string; score: number }> | null = null;
  try {
    const { status, data } = await forwardWorkerSearch(
      worker,
      { query: text, precision: input.precision, rewrites, limit: WORKER_CANDIDATE_LIMIT },
      ctx.signal,
    );
    ranked = status === 200 ? parseRankedResults(data) : null;
    if (!ranked) console.error(`[bookmark-service] worker search returned ${status}`);
  } catch (err) {
    console.error("[bookmark-service] worker search failed:", err);
  }

  if (!ranked) {
    // Same graceful degradation as the UI: substring match, newest first.
    const q = text.toLowerCase();
    const matched = posts
      .filter((post) => passes(post) && searchable(post).includes(q))
      .sort((a, b) => postTime(b) - postTime(a));
    const top = matched.slice(0, input.limit);
    return {
      ...base,
      mode: "substring-fallback",
      warnings: [...warnings, "Semantic search is temporarily unavailable; results are a plain substring match."],
      totalMatches: matched.length,
      count: top.length,
      results: top.map(toSearchHit),
    };
  }

  // Worker order is score-desc already; hydrate and filter while preserving it.
  const matched: SearchHit[] = [];
  for (const { id, score } of ranked) {
    const post = byId.get(id);
    if (post && passes(post)) matched.push({ ...toSearchHit(post), score: Math.round(score * 1e4) / 1e4 });
  }
  const top = matched.slice(0, input.limit);
  return { ...base, mode: "ranked", totalMatches: matched.length, count: top.length, results: top };
}

// ============================== Single bookmark ==============================

export async function getBookmark(id: string) {
  const { byId } = await loadArchive();
  const post = byId.get(id.trim());
  return post ? toBookmarkDetail(post) : null;
}
