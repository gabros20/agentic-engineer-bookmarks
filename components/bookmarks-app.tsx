"use client";

import { ArrowUp, Bookmark as BookmarkIcon, ListOrdered, Menu as MenuIcon, MessagesSquare, Search, SlidersHorizontal, Sparkles, Star, X as XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { BookmarkCard } from "@/components/bookmark-card";
import { CommandKChat, type ChatContextSnapshot } from "@/components/command-k-chat";
import { DigestPanel } from "@/components/digest-panel";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SavedChatsPanel } from "@/components/saved-chats-panel";
import { SavedDigestsPanel } from "@/components/saved-digests-panel";
import { OptionSelect } from "@/components/ui/select";
import { UnlockForm } from "@/components/unlock-form";
import { listSavedChats, type SavedChat } from "@/lib/chat-history";
import type {
  GetBookmarkInput,
  GetBookmarkResult,
  SearchBookmarksInput,
  SearchBookmarksResult,
} from "@/lib/chat-tools";
import { getDigest, listSavedDigests, type SavedDigest } from "@/lib/digest-cache";
import { toDigestSource } from "@/lib/digest-source";
import type { DigestSource } from "@/lib/digest-schema";
import { fetchQueryRewrites } from "@/lib/expand-client";
import type { DataWorkerMessage } from "@/lib/data-worker";
import { useLanguage } from "@/lib/i18n";
import type { UIMessage } from "ai";
import {
  buildKeywordIndex,
  expandSemanticQueries,
  keywordSearch,
  multiVectorSearch,
  runHybridPipeline,
  type SearchIndexPayload,
  type SearchPrecision,
} from "@/lib/bookmark-search";
import type { BookmarkPost } from "@/lib/bookmark-types";
import { normalizeBookmarkPayload } from "@/lib/xrelay-archive";
import type { ProgressInfo } from "@huggingface/transformers";

const FAVORITES_KEY = "agentic-engineer-bookmarks:favorites";
const SEARCH_DEBOUNCE_MS = 350;
const PAGE_SIZE = 240;

let extractorPromise: Promise<unknown> | null = null;

// Module-level model-download tracking, decoupled from any single component instance so
// idle warmup (warmupEmbedder) and on-demand calls (embedQueries) both observe/update the
// same state regardless of which one wins the `extractorPromise ??=` race below. Read via
// useSyncExternalStore in the component — re-renders are driven by the throttled
// setModelDownloadState() calls in handleModelProgress, not by raw progress ticks
// (Transformers.js can fire many "progress" events per second reading a large file).
type ModelDownloadState = { status: "idle" | "downloading" | "ready" | "failed"; pct: number };

// Stable reference (not reallocated) so useSyncExternalStore's server/idle snapshot never
// appears to "change" identity between calls.
const IDLE_MODEL_DOWNLOAD_STATE: ModelDownloadState = { status: "idle", pct: 0 };
let modelDownloadState: ModelDownloadState = IDLE_MODEL_DOWNLOAD_STATE;
const modelDownloadListeners = new Set<() => void>();

function setModelDownloadState(next: ModelDownloadState) {
  modelDownloadState = next;
  for (const listener of modelDownloadListeners) listener();
}

function subscribeModelDownloadState(listener: () => void) {
  modelDownloadListeners.add(listener);
  return () => {
    modelDownloadListeners.delete(listener);
  };
}

function getModelDownloadStateSnapshot() {
  return modelDownloadState;
}

// The model download only ever happens client-side, so both the server render and the
// pre-hydration client render see "idle".
function getModelDownloadServerSnapshot() {
  return IDLE_MODEL_DOWNLOAD_STATE;
}

// Throttle: notify subscribers (i.e. trigger a re-render) on real progress, not on every
// tick. Always emit immediately on the very first tick (idle -> downloading, so the UI can
// leave "warming up" right away) and on completion (>=100%); otherwise gate to >=500ms or a
// >=5-point step since the last emitted value, per the brief's throttling requirement.
let lastProgressNotifyAt = 0;
let lastProgressNotifyPct = -1;

// Transformers.js wraps any progress_callback passed to pipeline() in a
// DefaultProgressCallback that, alongside the raw per-file "progress" events, also
// synthesizes a "progress_total" event aggregating loaded/total bytes across every file the
// model needs (tokenizer.json, config.json, the quantized onnx weights, ...) — confirmed by
// reading node_modules/@huggingface/transformers/src/utils/core.js. That aggregate is a
// better fit than hand-picking "the main model file" (the brief's original framing): it's
// already correct for single- or multi-file models and doesn't require guessing a filename.
function handleModelProgress(info: ProgressInfo) {
  if (info.status === "progress_total") {
    const pct = Math.max(0, Math.min(100, Math.round(info.progress)));
    const now = Date.now();
    const isFirstTick = modelDownloadState.status !== "downloading";
    const dueByTime = now - lastProgressNotifyAt >= 500;
    const dueByStep = Math.abs(pct - lastProgressNotifyPct) >= 5;
    if (!isFirstTick && pct < 100 && !dueByTime && !dueByStep) return;
    lastProgressNotifyAt = now;
    lastProgressNotifyPct = pct;
    setModelDownloadState({ status: "downloading", pct });
  } else if (info.status === "ready") {
    setModelDownloadState({ status: "ready", pct: 100 });
  }
}

// Idle-time warmup of the embedding pipeline: idempotent (reuses extractorPromise, same as
// embedQueries) and always wires handleModelProgress so download tracking works no matter
// which call site (warmup or a real on-demand embedQueries call) wins the `??=` race. Never
// throws — warmup failure must never break anything. On failure it resets extractorPromise
// so the NEXT call gets a fresh attempt instead of permanently re-throwing this same
// rejected promise; the lazy embedQueries path is what actually retries.
async function warmupEmbedder(model: string) {
  try {
    const { pipeline } = await import("@huggingface/transformers");
    extractorPromise ??= pipeline("feature-extraction", model, { progress_callback: handleModelProgress });
    await extractorPromise;
  } catch {
    extractorPromise = null;
    setModelDownloadState({ status: "failed", pct: 0 });
  }
}

// Schedules work for an idle browser slot, falling back to a fixed delay where
// requestIdleCallback is unavailable (Safari). Browser-API access stays inside this helper
// so callers only ever invoke it from effects — SSR-safe, since React effects never run
// during server rendering even in a "use client" component.
function scheduleIdle(callback: () => void) {
  if (typeof window === "undefined") return { cancel: () => {} };
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(() => callback());
    return { cancel: () => window.cancelIdleCallback(id) };
  }
  const id = window.setTimeout(callback, 1500);
  return { cancel: () => window.clearTimeout(id) };
}

const formatter = new Intl.NumberFormat("en");

function number(value?: number) {
  return formatter.format(value ?? 0);
}

function searchable(post: BookmarkPost) {
  return [
    post.text,
    post.articleTitle,
    post.articleText,
    post.author.name,
    post.author.screenName,
    ...(post.urls ?? []),
    post.quotedTweet?.text,
    post.quotedTweet?.author?.name,
    post.quotedTweet?.author?.screenName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function byDate(post: BookmarkPost) {
  return new Date(post.createdAtISO ?? post.createdAt ?? 0).getTime();
}

// Prefix threading is keyed off the loaded index's `prefix_scheme` field, never off the
// model name — an old (v1 MiniLM) index has no `prefix_scheme` and gets zero prefix, so the
// client stays byte-identical against it. Only a new "e5" index gets "query: " prepended.
async function embedQueries(queries: string[], index: SearchIndexPayload) {
  const { pipeline } = await import("@huggingface/transformers");
  extractorPromise ??= pipeline("feature-extraction", index.model, { progress_callback: handleModelProgress });
  const extractor = (await extractorPromise) as (
    text: string,
    options: { pooling: "mean"; normalize: boolean },
  ) => Promise<{ data: Iterable<number> }>;
  const prefix = index.prefix_scheme === "e5" ? "query: " : "";
  const embeddings: number[][] = [];

  for (const query of queries) {
    const output = await extractor(`${prefix}${query}`, { pooling: "mean", normalize: true });
    embeddings.push(Array.from(output.data));
  }

  return embeddings;
}

// T3.1: merge static QUERY_EXPANSIONS-derived expansions with LLM rewrites from
// /api/expand. `staticExpansions` already starts with the normalized original query
// (expandSemanticQueries' first Set entry), so appending rewrites after it and deduping
// naturally yields [normalized original, ...static expansions, ...LLM rewrites] with no
// separate "prepend original" step needed. Case-insensitive dedupe (LLM rewrites may not
// match the lowercase-normalized static entries byte-for-byte) and the same cap of 8 that
// expandSemanticQueries itself enforces, so static (proven) signals are preferred when the
// combined list would otherwise exceed the cap.
function mergeExpansions(staticExpansions: string[], rewrites: string[]) {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const candidate of [...staticExpansions, ...rewrites]) {
    const key = candidate.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged.slice(0, 8);
}

export function BookmarksApp() {
  const { t, lang } = useLanguage();
  const [payload, setPayload] = useState<unknown>(null);
  const [searchIndex, setSearchIndex] = useState<SearchIndexPayload | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [scope, setScope] = useState("all");
  const [precision, setPrecision] = useState<SearchPrecision>("exact");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [hybridResults, setHybridResults] = useState<Map<string, number> | null>(null);
  const [searchStatusKey, setSearchStatusKey] = useState<
    | "status.keyword"
    | "status.semanticReady"
    | "status.exactWarming"
    | "status.broadExpansionWarming"
    | "status.broadWarming"
    | "status.exactHybrid"
    | "status.broadExpansion"
    | "status.broadHybrid"
  >("status.keyword");
  const [error, setError] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [digestUnlocked, setDigestUnlocked] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [digestPayload, setDigestPayload] = useState<{
    query: string;
    sources?: DigestSource[];
    initialCached?: SavedDigest;
  } | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [pendingDigest, setPendingDigest] = useState<{ query: string; sources: DigestSource[] } | null>(null);

  // Chat state
  const [chatOpen, setChatOpen] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatHistoryMessages, setChatHistoryMessages] = useState<UIMessage[] | null>(null);
  const [chatInitialPrompt, setChatInitialPrompt] = useState<string | null>(null);
  const [savedChatsCount, setSavedChatsCount] = useState(0);
  const [pendingChatOpen, setPendingChatOpen] = useState(false);
  const [pendingShortlistPrompt, setPendingShortlistPrompt] = useState<string | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    setSavedCount(listSavedDigests().length);
    setSavedChatsCount(listSavedChats().length);
  }, []);

  useEffect(() => {
    if (!savedOpen && !digestOpen) setSavedCount(listSavedDigests().length);
    if (!chatOpen && !chatHistoryOpen) setSavedChatsCount(listSavedChats().length);
  }, [savedOpen, digestOpen, chatOpen, chatHistoryOpen]);

  useEffect(() => {
    setDigestUnlocked(document.cookie.split("; ").some((c) => c.startsWith("digest_ok=1")));
  }, []);

  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 400);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ⌘K / Ctrl+K to toggle the chat. Same passkey gate as the AI Digest CTA.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (chatOpen) {
          setChatOpen(false);
          return;
        }
        if (digestUnlocked) {
          setChatHistoryMessages(null);
          setChatOpen(true);
        } else {
          setPendingChatOpen(true);
          setUnlockOpen(true);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen, digestUnlocked]);

  // Fetch + parse both JSON payloads in a Web Worker so JSON.parse
  // doesn't freeze the main thread on a 10 MB string. Each result is
  // posted back independently so cards can render the moment bookmarks
  // are ready, even before the search index finishes.
  useEffect(() => {
    const worker = new Worker(new URL("../lib/data-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<DataWorkerMessage>) => {
      const msg = event.data;
      if (msg.type === "bookmarks") setPayload(msg.payload);
      else if (msg.type === "searchIndex") setSearchIndex(msg.payload as SearchIndexPayload);
      else if (msg.type === "error") {
        if (msg.which === "bookmarks") setError(msg.message);
        else setSearchStatusKey("status.keyword");
      }
    };
    worker.postMessage("load");
    return () => worker.terminate();
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(FAVORITES_KEY);
      if (!stored) return;
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) setFavorites(new Set(parsed.map(String)));
    } catch {
      setFavorites(new Set());
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
  }, [favorites]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [query]);

  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [query, scope, sort]);

  const posts = useMemo(() => normalizeBookmarkPayload(payload), [payload]);
  const [keywordIndex, setKeywordIndex] = useState<ReturnType<typeof buildKeywordIndex> | null>(null);
  const modelDownloadState = useSyncExternalStore(
    subscribeModelDownloadState,
    getModelDownloadStateSnapshot,
    getModelDownloadServerSnapshot,
  );

  // Build the lunr keyword index (~0.8-1.0s main-thread on ~5,370 posts, T1.4 carry-over
  // from Task 7's review) off the interaction-critical path: idle-scheduled once posts
  // arrive. If the user types a query before this fires, the search effect below builds it
  // synchronously on demand instead (see comment there) — this effect is then a no-op.
  useEffect(() => {
    if (!posts.length || keywordIndex) return;
    const handle = scheduleIdle(() => {
      setKeywordIndex((current) => current ?? buildKeywordIndex(posts));
    });
    return () => handle.cancel();
  }, [posts, keywordIndex]);

  // Idle-warm the embedding pipeline as soon as the search index arrives, so the ~112 MB
  // multilingual-e5-small download usually finishes before the user's first semantic
  // search. Runs after the keyword-index effect above is scheduled (searchIndex tends to
  // arrive at the same time as or after `posts`, since both are parallel worker fetches and
  // the search index payload is the larger of the two) but the two are independent: nothing
  // here waits on the keyword build, and warmup's own idle-callback work is just kicking off
  // an async fetch, not CPU-bound, so the two idle callbacks don't meaningfully contend even
  // if scheduled back-to-back.
  useEffect(() => {
    if (!searchIndex) return;
    const handle = scheduleIdle(() => {
      void warmupEmbedder(searchIndex.model);
    });
    return () => handle.cancel();
  }, [searchIndex]);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q || !posts.length) {
      setHybridResults(null);
      setSearchStatusKey(searchIndex ? "status.semanticReady" : "status.keyword");
      return;
    }

    // Early typing before the idle-scheduled build above ran: build synchronously right
    // here, exactly like the old unconditional useMemo did, so a query typed at t=0 still
    // works today (no regression). Net effect: page load never pays the ~1s build on the
    // interaction path; typing early still pays what it pays today.
    const index = keywordIndex ?? buildKeywordIndex(posts);
    if (!keywordIndex) setKeywordIndex(index);

    let cancelled = false;
    const rewriteController = new AbortController();
    const keywordResults = keywordSearch(index, q);

    if (!searchIndex) {
      setHybridResults(new Map(keywordResults.map((result) => [result.id, result.score])));
      setSearchStatusKey("status.keyword");
      return;
    }

    const staticExpansions = expandSemanticQueries(q, precision);
    setSearchStatusKey(
      precision === "exact"
        ? "status.exactWarming"
        : staticExpansions.length > 1
          ? "status.broadExpansionWarming"
          : "status.broadWarming",
    );

    // T3.1: broad mode, unlocked users only, get an LLM-rewrite pass merged in before
    // embedding. fetchQueryRewrites has its own hard non-blocking-failure contract (empty
    // array on timeout/error/abort — see lib/expand-client.ts), so this branch never adds
    // unbounded latency or a new failure mode: on empty rewrites the merge is a no-op and
    // behavior is byte-identical to today's static-only expansion.
    const expandedQueriesPromise: Promise<string[]> =
      precision === "broad" && digestUnlocked
        ? fetchQueryRewrites(q, lang, rewriteController.signal).then((rewrites) =>
            mergeExpansions(staticExpansions, rewrites),
          )
        : Promise.resolve(staticExpansions);

    expandedQueriesPromise
      .then((expandedQueries) =>
        embedQueries(expandedQueries, searchIndex).then((embeddings) => ({ expandedQueries, embeddings })),
      )
      .then(({ expandedQueries, embeddings }) => {
        if (cancelled) return;
        const pooledVectorResults = multiVectorSearch(searchIndex, embeddings);
        const finalResults = runHybridPipeline(keywordResults, pooledVectorResults, precision, searchIndex);
        setHybridResults(new Map(finalResults.map((result) => [result.id, result.score])));
        setSearchStatusKey(
          precision === "exact"
            ? "status.exactHybrid"
            : expandedQueries.length > 1
              ? "status.broadExpansion"
              : "status.broadHybrid",
        );
      })
      .catch(() => {
        if (cancelled) return;
        setHybridResults(new Map(keywordResults.map((result) => [result.id, result.score])));
        setSearchStatusKey("status.keyword");
      });

    return () => {
      cancelled = true;
      rewriteController.abort();
    };
  }, [debouncedQuery, keywordIndex, posts, precision, searchIndex, digestUnlocked, lang]);

  const visiblePosts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scoped = posts.filter((post) => {
      if (scope === "favorites") return favorites.has(post.id);
      if (scope === "articles") return Boolean(post.articleTitle);
      if (scope === "media") return Boolean(post.media?.length);
      if (scope === "photos") return post.media?.some((item) => item.type === "photo");
      if (scope === "videos") return post.media?.some((item) => item.type === "video" || item.type === "animated_gif");
      if (scope === "text") return !post.media?.length && !post.articleTitle;
      return true;
    });
    const filtered = q
      ? hybridResults
        ? scoped.filter((post) => hybridResults.has(post.id))
        : scoped.filter((post) => searchable(post).includes(q))
      : scoped;

    return [...filtered].sort((a, b) => {
      if (q && hybridResults) return (hybridResults.get(b.id) ?? 0) - (hybridResults.get(a.id) ?? 0);
      if (sort === "oldest") return byDate(a) - byDate(b);
      if (sort === "bookmarks") return (b.metrics?.bookmarks ?? 0) - (a.metrics?.bookmarks ?? 0);
      if (sort === "likes") return (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0);
      return byDate(b) - byDate(a);
    });
  }, [favorites, hybridResults, posts, query, scope, sort]);

  const displayedPosts = visiblePosts.slice(0, visibleLimit);

  // Status precedence while a query is active: downloading (with pct) takes over the
  // existing "warming up" keys, which in turn take over once the hybrid results land. Kept
  // as a derived render value (not folded into searchStatusKey itself) so download-progress
  // ticks never re-trigger the search effect above — only this cheap string computation.
  // When no query is typed, searchStatusKey is never one of the *Warming keys, so the
  // download never surfaces here — it runs silently, per the brief.
  const isModelWarmingStatus =
    searchStatusKey === "status.exactWarming" ||
    searchStatusKey === "status.broadExpansionWarming" ||
    searchStatusKey === "status.broadWarming";
  const statusText =
    isModelWarmingStatus && modelDownloadState.status === "downloading"
      ? t("status.modelDownloading", { pct: modelDownloadState.pct })
      : t(searchStatusKey);

  // Chat context snapshot taken whenever the chat opens.
  const chatContext = useMemo<ChatContextSnapshot>(() => {
    const q = query.trim();
    return {
      language: lang,
      query: q || null,
      precision: q ? precision : null,
      sources: visiblePosts.slice(0, 20).map(toDigestSource),
      digest: q ? getDigest(q) : null,
    };
  }, [lang, query, precision, visiblePosts]);

  // search_bookmarks tool executor — runs the same hybrid search the live UI uses.
  async function runChatSearch(input: SearchBookmarksInput): Promise<SearchBookmarksResult> {
    const q = input.query.trim();
    if (!q || posts.length === 0) return { count: 0, results: [] };
    // Same on-demand fallback as the main search effect: the idle-scheduled build may not
    // have run yet (e.g. chat opened immediately via ⌘K on a cold load).
    const index = keywordIndex ?? buildKeywordIndex(posts);
    if (!keywordIndex) setKeywordIndex(index);
    const kw = keywordSearch(index, q);
    let ranked: { id: string; score: number }[];
    if (searchIndex) {
      const queries = expandSemanticQueries(q, input.precision);
      const embeddings = await embedQueries(queries, searchIndex);
      const pooledVec = multiVectorSearch(searchIndex, embeddings);
      ranked = runHybridPipeline(kw, pooledVec, input.precision, searchIndex);
    } else {
      ranked = kw;
    }
    const ids = new Set(ranked.map((r) => r.id));
    const score = new Map(ranked.map((r) => [r.id, r.score]));
    let pool = posts.filter((p) => ids.has(p.id));
    if (input.filter === "article") pool = pool.filter((p) => p.articleTitle || p.articleText);
    else if (input.filter === "media") pool = pool.filter((p) => (p.media?.length ?? 0) > 0);
    else if (input.filter === "text") pool = pool.filter((p) => !(p.media?.length));
    pool.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0));
    const top = pool.slice(0, input.limit);
    return {
      count: top.length,
      results: top.map((p) => ({
        id: p.id,
        author: p.author?.name ?? p.author?.screenName ?? "",
        screenName: p.author?.screenName ?? "",
        text: (p.text ?? "").slice(0, 280),
        articleTitle: p.articleTitle,
        url: `https://x.com/${p.author?.screenName ?? "i"}/status/${p.id}`,
        createdAt: p.createdAtISO ?? p.createdAt,
        likes: p.metrics?.likes,
        bookmarks: p.metrics?.bookmarks,
      })),
    };
  }

  function getChatBookmark(input: GetBookmarkInput): GetBookmarkResult {
    const post = posts.find((p) => p.id === input.id);
    if (!post) return { found: false };
    return {
      found: true,
      bookmark: {
        id: post.id,
        author: post.author?.name ?? post.author?.screenName ?? "",
        screenName: post.author?.screenName ?? "",
        text: post.text ?? "",
        articleTitle: post.articleTitle,
        articleText: post.articleText,
        url: `https://x.com/${post.author?.screenName ?? "i"}/status/${post.id}`,
        createdAt: post.createdAtISO ?? post.createdAt,
        metrics: post.metrics,
      },
    };
  }

  function BookmarkCardSkeleton({ index }: { index: number }) {
    // Vary heights so the masonry column pattern feels organic.
    const heights = ["h-44", "h-56", "h-36", "h-52", "h-40", "h-60", "h-48", "h-44"];
    const h = heights[index % heights.length];
    return (
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: index * 0.04, duration: 0.25 }}
        className={`mb-4 inline-block w-full break-inside-avoid rounded-xl border border-[color:var(--color-hairline)] bg-[color:var(--color-surface-soft)] p-4 align-top`}
      >
        <div className="flex items-center gap-2">
          <div className="h-10 w-10 animate-pulse rounded-full bg-[color:var(--color-hairline)]" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="h-3 w-24 animate-pulse rounded bg-[color:var(--color-hairline)]" />
            <div className="h-3 w-16 animate-pulse rounded bg-[color:var(--color-hairline-soft)]" />
          </div>
        </div>
        <div className={`mt-3 ${h} animate-pulse rounded-md bg-[color:var(--color-hairline-soft)]`} />
      </motion.div>
    );
  }

  function toggleFavorite(id: string) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <main className="mx-auto min-h-screen w-full bg-[color:var(--color-canvas)] text-[color:var(--color-body)]">
      <header className="sticky top-0 z-20 border-b border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)]/90 px-3 py-3 backdrop-blur-xl sm:px-4 sm:py-4">
        <div className="flex w-full items-start justify-between gap-2 sm:gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-col gap-y-0.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-3 sm:gap-y-1">
              <h1 className="font-display text-[22px] leading-tight text-[color:var(--color-ink)] sm:text-[36px]">
                {t("app.title")}
              </h1>
              <p className="text-[12px] leading-4 text-[color:var(--color-muted)] sm:text-[13px] sm:leading-5">
                {t("app.subtitle", { n: number(posts.length) })}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            aria-label="Menu"
            aria-expanded={mobileMenuOpen}
            className="grid size-9 shrink-0 place-items-center rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)] sm:hidden"
          >
            {mobileMenuOpen ? <XIcon size={16} /> : <MenuIcon size={16} />}
          </button>

          <div className="hidden flex-wrap items-center justify-end gap-2 sm:flex">
            <button
              type="button"
              onClick={() => {
                if (digestUnlocked) {
                  setChatHistoryMessages(null);
                  setChatOpen(true);
                } else {
                  setPendingChatOpen(true);
                  setUnlockOpen(true);
                }
              }}
              className="flex items-center gap-1.5 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-3 py-2 text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)]"
              aria-label={t("chat.title")}
              title={t("chat.openHint")}
            >
              <Sparkles size={14} className="text-[color:var(--color-primary)]" />
              <span className="hidden sm:inline">{t("chat.title")}</span>
              <kbd className="hidden rounded border border-[color:var(--color-hairline)] bg-[color:var(--color-surface-card)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[color:var(--color-muted)] sm:inline">
                ⌘K
              </kbd>
            </button>
            {digestUnlocked ? (
              <>
                <button
                  type="button"
                  onClick={() => setChatHistoryOpen(true)}
                  className="flex items-center gap-1.5 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-3 py-2 text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)]"
                  aria-label={t("chat.history")}
                  title={t("chat.history")}
                >
                  <MessagesSquare size={14} className="text-[color:var(--color-primary)]" />
                  {savedChatsCount > 0 ? number(savedChatsCount) : null}
                </button>
                <button
                  type="button"
                  onClick={() => setSavedOpen(true)}
                  className="flex items-center gap-1.5 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-3 py-2 text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)]"
                  aria-label={t("app.aria.savedDigests")}
                  title={t("app.saved")}
                >
                  <BookmarkIcon size={14} className="text-[color:var(--color-primary)]" />
                  {savedCount > 0 ? number(savedCount) : null}
                </button>
              </>
            ) : null}
            {favorites.size > 0 ? (
              <div
                className="flex items-center gap-1.5 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-3 py-2 text-sm font-medium text-[color:var(--color-ink)]"
                title={t("app.starred")}
              >
                <Star size={14} className="fill-[color:var(--color-primary)] text-[color:var(--color-primary)]" />
                {number(favorites.size)}
                <span className="hidden sm:inline">{t("app.starred")}</span>
              </div>
            ) : null}
            <LanguageSwitcher />
          </div>
        </div>

        <AnimatePresence initial={false}>
          {mobileMenuOpen ? (
            <motion.div
              key="mobile-menu"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="overflow-hidden sm:hidden"
            >
              <div className="mt-3 flex flex-col gap-1 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    if (digestUnlocked) {
                      setChatHistoryMessages(null);
                      setChatOpen(true);
                    } else {
                      setPendingChatOpen(true);
                      setUnlockOpen(true);
                    }
                  }}
                  className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)]"
                >
                  <Sparkles size={16} className="text-[color:var(--color-primary)]" />
                  {t("chat.title")}
                </button>
                {digestUnlocked ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setMobileMenuOpen(false);
                        setChatHistoryOpen(true);
                      }}
                      className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)]"
                    >
                      <MessagesSquare size={16} className="text-[color:var(--color-primary)]" />
                      <span className="flex-1">{t("chat.history")}</span>
                      {savedChatsCount > 0 ? (
                        <span className="text-xs text-[color:var(--color-muted)]">{number(savedChatsCount)}</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMobileMenuOpen(false);
                        setSavedOpen(true);
                      }}
                      className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)]"
                    >
                      <BookmarkIcon size={16} className="text-[color:var(--color-primary)]" />
                      <span className="flex-1">{t("app.saved")}</span>
                      {savedCount > 0 ? (
                        <span className="text-xs text-[color:var(--color-muted)]">{number(savedCount)}</span>
                      ) : null}
                    </button>
                  </>
                ) : null}
                {favorites.size > 0 ? (
                  <div className="flex w-full items-center gap-3 px-3 py-2.5 text-sm font-medium text-[color:var(--color-ink)]">
                    <Star size={16} className="fill-[color:var(--color-primary)] text-[color:var(--color-primary)]" />
                    <span className="flex-1">{t("app.starred")}</span>
                    <span className="text-xs text-[color:var(--color-muted)]">{number(favorites.size)}</span>
                  </div>
                ) : null}
                <div className="mt-1 flex items-center justify-between gap-3 border-t border-[color:var(--color-hairline)] px-3 pt-2.5">
                  <span className="text-xs uppercase tracking-wide text-[color:var(--color-muted)]">{t("lang.label")}</span>
                  <LanguageSwitcher />
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </header>

      <section className="grid w-full gap-2 border-b border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-3 sm:gap-3 sm:p-4">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-muted)] sm:left-4" size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-10 w-full rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] pl-9 pr-[112px] text-base text-[color:var(--color-ink)] outline-none transition placeholder:text-[color:var(--color-muted)] focus:border-[color:var(--color-primary)] focus:ring-[3px] focus:ring-[color:var(--color-primary)]/15 sm:min-h-11 sm:pl-11 sm:pr-32"
            placeholder={t("search.placeholder")}
            type="search"
          />
          <div
            role="group"
            aria-label={t("search.precision.aria")}
            className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-0.5 text-[10px] font-semibold sm:right-1.5 sm:text-[11px]"
          >
            {(["exact", "broad"] as const).map((value) => (
              <motion.button
                key={value}
                type="button"
                onClick={() => setPrecision(value)}
                aria-pressed={precision === value}
                whileTap={{ scale: 0.94 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className={`relative min-h-7 rounded-sm px-2 sm:min-h-8 sm:px-3 ${
                  precision === value
                    ? "text-[color:var(--color-on-primary)]"
                    : "text-[color:var(--color-muted)] hover:text-[color:var(--color-ink)]"
                }`}
              >
                {precision === value ? (
                  <motion.span
                    layoutId="precision-active"
                    className="absolute inset-0 rounded-sm bg-[color:var(--color-primary)]"
                    transition={{ type: "spring", stiffness: 500, damping: 40 }}
                  />
                ) : null}
                <span className="relative">
                  {value === "exact" ? t("search.precision.exact") : t("search.precision.broad")}
                </span>
              </motion.button>
            ))}
          </div>
        </label>

        <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 sm:gap-2">
          <OptionSelect
            value={sort}
            onValueChange={setSort}
            ariaLabel={t("sort.newest")}
            leadingIcon={<SlidersHorizontal size={14} />}
            className="h-9 px-2.5 text-[13px] sm:h-10 sm:px-3 sm:text-sm"
            options={[
              { value: "newest", label: t("sort.newest") },
              { value: "oldest", label: t("sort.oldest") },
              { value: "bookmarks", label: t("sort.bookmarks") },
              { value: "likes", label: t("sort.likes") },
            ]}
          />

          <OptionSelect
            value={scope}
            onValueChange={setScope}
            ariaLabel={t("scope.all")}
            leadingIcon={<Star size={14} />}
            className="h-9 px-2.5 text-[13px] sm:h-10 sm:px-3 sm:text-sm"
            options={[
              { value: "all", label: t("scope.all") },
              { value: "favorites", label: t("scope.favorites") },
              { value: "articles", label: t("scope.articles") },
              { value: "media", label: t("scope.media") },
              { value: "photos", label: t("scope.photos") },
              { value: "videos", label: t("scope.videos") },
              { value: "text", label: t("scope.text") },
            ]}
          />

          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            onClick={() => {
              setQuery("");
              setSort("newest");
              setScope("all");
              setPrecision("exact");
            }}
            className="min-h-9 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-3 text-[13px] font-medium text-[color:var(--color-ink)] transition-colors hover:bg-[color:var(--color-surface-card)] sm:min-h-10 sm:px-4 sm:text-sm"
          >
            {t("action.clear")}
          </motion.button>
        </div>

        <AnimatePresence initial={false}>
          {query.trim() && visiblePosts.length > 0 ? (
            <motion.div
              key="ai-ctas"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="flex flex-col gap-2 sm:flex-row"
            >
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => {
                  const sources = visiblePosts.slice(0, 30).map(toDigestSource);
                  const payload = { query: query.trim(), sources };
                  if (digestUnlocked) {
                    setDigestPayload(payload);
                    setDigestOpen(true);
                  } else {
                    setPendingDigest(payload);
                    setUnlockOpen(true);
                  }
                }}
                className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-[color:var(--color-primary)] px-5 text-sm font-medium text-[color:var(--color-on-primary)] transition-colors hover:bg-[color:var(--color-primary-active)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--color-primary)]/30"
              >
                <Sparkles size={16} />
                <span>{t("action.aiDigest", { n: Math.min(30, visiblePosts.length) })}</span>
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => {
                  const q = query.trim();
                  if (!q) return;
                  const prompt = t("chat.shortlistPrompt", { q });
                  if (digestUnlocked) {
                    setChatHistoryMessages(null);
                    setChatInitialPrompt(prompt);
                    setChatOpen(true);
                  } else {
                    setPendingShortlistPrompt(prompt);
                    setPendingChatOpen(true);
                    setUnlockOpen(true);
                  }
                }}
                className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md border border-[color:var(--color-primary)] bg-[color:var(--color-canvas)] px-5 text-sm font-medium text-[color:var(--color-primary)] transition-colors hover:bg-[color:var(--color-primary)]/10 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--color-primary)]/30"
              >
                <ListOrdered size={16} />
                <span>{t("action.aiShortlist")}</span>
              </motion.button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </section>

      <p className="w-full border-b border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-3 py-2 text-[12px] leading-4 text-[color:var(--color-muted)] sm:px-4 sm:py-3 sm:text-sm sm:leading-5">
        {error
          ? error
          : t("status.summary", {
              shown: number(displayedPosts.length),
              total: number(visiblePosts.length),
              status: statusText,
            })}
      </p>

      {error ? null : payload === null ? (
        <section aria-busy="true" className="w-full columns-1 gap-3 p-3 sm:gap-4 sm:p-4 sm:columns-[20rem]">
          {Array.from({ length: 8 }).map((_, i) => (
            <BookmarkCardSkeleton key={i} index={i} />
          ))}
        </section>
      ) : (
        <section className="w-full columns-1 gap-3 p-3 sm:gap-4 sm:p-4 sm:columns-[20rem]">
          {displayedPosts.map((post) => (
            <BookmarkCard
              key={post.id}
              post={post}
              isFavorite={favorites.has(post.id)}
              onToggleFavorite={toggleFavorite}
            />
          ))}
        </section>
      )}

      {!error && visiblePosts.length > displayedPosts.length ? (
        <div className="grid w-full place-items-center px-4 pb-8">
          <button
            type="button"
            onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}
            className="min-h-11 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-5 text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)]"
          >
            {t("action.loadMore", { n: number(Math.min(PAGE_SIZE, visiblePosts.length - displayedPosts.length)) })}
          </button>
        </div>
      ) : null}

      {!error && visiblePosts.length === 0 ? (
        <section className="w-full p-12 text-center text-[color:var(--color-muted)]">
          {t("empty.results")}
        </section>
      ) : null}

      <AnimatePresence>
        {digestOpen && digestPayload ? (
          <DigestPanel
            key={`${digestPayload.query}::${digestPayload.initialCached?.createdAt ?? "live"}`}
            query={digestPayload.query}
            sources={digestPayload.sources}
            initialCached={digestPayload.initialCached}
            onClose={() => {
              setDigestOpen(false);
              setDigestPayload(null);
            }}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {savedOpen ? (
          <SavedDigestsPanel
            onClose={() => setSavedOpen(false)}
            onOpenDigest={(saved) => {
              setDigestPayload({ query: saved.query, initialCached: saved });
              setSavedOpen(false);
              setDigestOpen(true);
            }}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {unlockOpen ? (
          <UnlockForm
            onClose={() => {
              setUnlockOpen(false);
              setPendingDigest(null);
              setPendingChatOpen(false);
              setPendingShortlistPrompt(null);
            }}
            onUnlocked={() => {
              setDigestUnlocked(true);
              setUnlockOpen(false);
              if (pendingDigest) {
                setDigestPayload(pendingDigest);
                setPendingDigest(null);
                setDigestOpen(true);
              }
              if (pendingChatOpen) {
                setPendingChatOpen(false);
                setChatHistoryMessages(null);
                setChatInitialPrompt(pendingShortlistPrompt);
                setPendingShortlistPrompt(null);
                setChatOpen(true);
              }
            }}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {chatOpen ? (
          <CommandKChat
            key={chatHistoryMessages ? "chat-history" : chatInitialPrompt ? `chat-shortlist-${chatInitialPrompt}` : "chat-live"}
            context={chatContext}
            runSearch={runChatSearch}
            getBookmark={getChatBookmark}
            initialMessages={chatHistoryMessages ?? undefined}
            initialPrompt={chatInitialPrompt ?? undefined}
            onClose={() => {
              setChatOpen(false);
              setChatHistoryMessages(null);
              setChatInitialPrompt(null);
            }}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {chatHistoryOpen ? (
          <SavedChatsPanel
            onClose={() => setChatHistoryOpen(false)}
            onOpenChat={(saved) => {
              setChatHistoryMessages(saved.messages as UIMessage[]);
              setChatHistoryOpen(false);
              setChatOpen(true);
            }}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {showScrollTop ? (
          <motion.button
            key="scroll-top"
            type="button"
            aria-label={t("action.scrollTop")}
            onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            initial={{ opacity: 0, y: 12, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.9 }}
            whileTap={{ scale: 0.92 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="fixed bottom-5 right-5 z-30 grid h-12 w-12 place-items-center rounded-full bg-[color:var(--color-primary)] text-[color:var(--color-on-primary)] shadow-[0_4px_20px_rgba(20,20,19,0.15)] transition-colors hover:bg-[color:var(--color-primary-active)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--color-primary)]/30"
          >
            <ArrowUp size={20} />
          </motion.button>
        ) : null}
      </AnimatePresence>
    </main>
  );
}
