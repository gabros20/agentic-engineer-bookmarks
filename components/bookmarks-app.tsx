"use client";

import { ArrowUp, Bookmark as BookmarkIcon, ListOrdered, LogOut, Menu as MenuIcon, MessagesSquare, Search, SlidersHorizontal, Sparkles, Star, X as XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { BookmarkCard } from "@/components/bookmark-card";
import { CommandKChat, type ChatContextSnapshot } from "@/components/command-k-chat";
import { DigestPanel } from "@/components/digest-panel";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SavedChatsPanel } from "@/components/saved-chats-panel";
import { SavedDigestsPanel } from "@/components/saved-digests-panel";
import { OptionSelect } from "@/components/ui/select";
import { listSavedChats, type SavedChat } from "@/lib/chat-history";
import type {
  GetBookmarkInput,
  GetBookmarkResult,
  SearchBookmarksInput,
  SearchBookmarksResult,
} from "@/lib/chat-tools";
import { authClient } from "@/lib/auth-client";
import { getDigest, listSavedDigests, type SavedDigest } from "@/lib/digest-cache";
import { toDigestSource } from "@/lib/digest-source";
import type { DigestSource } from "@/lib/digest-schema";
import { fetchQueryRewrites } from "@/lib/expand-client";
import type { DataWorkerMessage } from "@/lib/data-worker";
import { useLanguage } from "@/lib/i18n";
import { parseQueryOperators, removeInvalidToken, removeOperatorTokens } from "@/lib/query-operators";
import type { UIMessage } from "ai";
import { type SearchPrecision } from "@/lib/bookmark-search";
import type { BookmarkPost } from "@/lib/bookmark-types";
import { normalizeBookmarkPayload } from "@/lib/xrelay-archive";
import { searchViaWorker } from "@/lib/search-client";

const FAVORITES_KEY = "agentic-engineer-bookmarks:favorites";
const SEARCH_DEBOUNCE_MS = 350;
const PAGE_SIZE = 240;
// T1 (digest engine upgrade): the digest CTA re-queries the Worker at this depth (deeper +
// reranked) instead of clustering the 30/PAGE_SIZE-limited posts currently on screen.
const DIGEST_SOURCE_LIMIT = 50;

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

// T4.1: render an operator Date back to the granularity the brief's examples use — a
// `YYYY-MM` token (before:/after: parsed to the 1st of that month) displays compactly as
// `YYYY-MM`; anything else (an explicit day was typed) displays as full `YYYY-MM-DD`. The
// parsed Date itself doesn't retain which form the user typed, so this is a deterministic
// re-derivation, not a stored flag — good enough for a chip/CTA label, not round-tripped
// back into parseQueryOperators.
function formatOperatorDate(date: Date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = date.getUTCDate();
  return d === 1 ? `${y}-${m}` : `${y}-${m}-${String(d).padStart(2, "0")}`;
}

export function BookmarksApp() {
  const { t, lang } = useLanguage();
  const [payload, setPayload] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [scope, setScope] = useState("all");
  const [precision, setPrecision] = useState<SearchPrecision>("exact");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [hybridResults, setHybridResults] = useState<Map<string, number> | null>(null);
  const [searchStatusKey, setSearchStatusKey] = useState<
    "status.ready" | "status.searching" | "status.results" | "status.offline"
  >("status.ready");
  const [error, setError] = useState<string | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  const [digestPayload, setDigestPayload] = useState<{
    query: string;
    sources?: DigestSource[];
    initialCached?: SavedDigest;
  } | null>(null);
  const [savedOpen, setSavedOpen] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  // T1 (digest engine upgrade): true while the CTA is re-querying the Worker at limit 50
  // (deeper sourcing) before opening the panel.
  const [digestSourcing, setDigestSourcing] = useState(false);

  // Chat state
  const [chatOpen, setChatOpen] = useState(false);
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [chatHistoryMessages, setChatHistoryMessages] = useState<UIMessage[] | null>(null);
  const [chatInitialPrompt, setChatInitialPrompt] = useState<string | null>(null);
  const [savedChatsCount, setSavedChatsCount] = useState(0);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const router = useRouter();

  // T3 login wall: sign out clears the Better Auth session, then routes to the
  // login screen (the server gate on / would redirect there anyway).
  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      router.replace("/login");
    }
  }

  useEffect(() => {
    setSavedCount(listSavedDigests().length);
    setSavedChatsCount(listSavedChats().length);
  }, []);

  useEffect(() => {
    if (!savedOpen && !digestOpen) setSavedCount(listSavedDigests().length);
    if (!chatOpen && !chatHistoryOpen) setSavedChatsCount(listSavedChats().length);
  }, [savedOpen, digestOpen, chatOpen, chatHistoryOpen]);

  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 400);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // ⌘K / Ctrl+K to toggle the chat. The app is behind login, so no extra gate — open directly.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (chatOpen) {
          setChatOpen(false);
          return;
        }
        setChatHistoryMessages(null);
        setChatOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen]);

  // Fetch + parse the bookmark JSON in a Web Worker so JSON.parse doesn't freeze the main
  // thread on a 10 MB string. Rendering-only data — the search index never reaches the
  // client anymore (T4): the Cloudflare Worker owns vectors, keyword index, and rerank docs.
  useEffect(() => {
    const worker = new Worker(new URL("../lib/data-worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<DataWorkerMessage>) => {
      const msg = event.data;
      if (msg.type === "bookmarks") setPayload(msg.payload);
      else if (msg.type === "error") setError(msg.message);
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

  // T4.1: parsed once per query change. `parsedQuery.text` is the RESIDUAL free text with
  // every `from:`/`before:`/`after:` token stripped out — this is what gets debounced below
  // and threaded through the whole rewrite-fetch + embed + hybrid-pipeline + rerank chain in
  // the search effect, so operator tokens never reach the embedder or /api/expand.
  const parsedQuery = useMemo(() => parseQueryOperators(query), [query]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(parsedQuery.text), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [parsedQuery.text]);

  // T4.2: auto-switch/restore state machine for the "relevance" sort option. `wasQueryActiveRef`
  // tracks whether the RAW query (including operator tokens, e.g. "from:simonw" with no residual
  // text) was non-empty on the previous run, so operators-only input still counts as "a search
  // started" for UX purposes — visiblePosts' sort branch below separately falls back to
  // newest-first when there's no active hybrid ranking to sort by, so an operators-only search
  // auto-switching to "relevance" is harmless. `previousSortRef` is written ONLY at the
  // empty->non-empty transition (search start), so mid-search manual sort picks never get
  // clobbered on later keystrokes, and clearing always restores whatever sort was active right
  // before this search began — not whatever was picked mid-search. Intentionally depends only on
  // `query` (not `sort`): reading `sort` here is fine even though it's outside the dep array,
  // since every render re-creates this closure with the current `sort` and the effect only fires
  // (using that render's closure) when `query` itself changes.
  const previousSortRef = useRef(sort);
  const wasQueryActiveRef = useRef(false);
  useEffect(() => {
    const isActive = query.trim().length > 0;
    const wasActive = wasQueryActiveRef.current;
    if (isActive && !wasActive) {
      previousSortRef.current = sort;
      setSort("relevance");
    } else if (!isActive && wasActive) {
      setSort(previousSortRef.current);
    }
    wasQueryActiveRef.current = isActive;
  }, [query]);

  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [query, scope, sort]);

  const posts = useMemo(() => normalizeBookmarkPayload(payload), [payload]);

  // T1 (digest engine upgrade): id -> post lookup used to map the Worker's deep re-query
  // ranked ids (digest CTA) back onto already-loaded posts, same pattern as runChatSearch's
  // ids/score maps below.
  const postsById = useMemo(() => new Map(posts.map((post) => [post.id, post])), [posts]);

  // T4 cutover: the search "engine" is now one debounced network round trip to the
  // Cloudflare Worker (lib/search-client.ts). No embedding, no keyword index, no rerank on
  // the client — the Worker runs the full hybrid + rerank pipeline server-side and returns
  // the SAME ranked-id shape (`{id, score}[]`) this component's hybridResults Map has always
  // consumed, so everything downstream (operator/scope filters, sorting, rendering) is
  // untouched. Typing therefore never blocks the main thread: the wait is network-only.
  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q || !posts.length) {
      setHybridResults(null);
      setSearchStatusKey("status.ready");
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setSearchStatusKey("status.searching");

    // LLM rewrites still fetched client-side (broad only, /api/expand — session-gated server
    // side now) and passed to the Worker, which merges them with its own static synonym
    // expansions server-side. fetchQueryRewrites has a hard non-blocking-failure contract ([]
    // on timeout/error/abort — lib/expand-client.ts), so a slow/dead LLM costs at most
    // REWRITE_TIMEOUT_MS, never a failed search.
    const rewritesPromise: Promise<string[]> =
      precision === "broad"
        ? fetchQueryRewrites(q, lang, controller.signal)
        : Promise.resolve<string[]>([]);

    rewritesPromise
      .then((rewrites) => searchViaWorker({ query: q, precision, rewrites, signal: controller.signal }))
      .then((results) => {
        if (cancelled) return;
        setHybridResults(new Map(results.map((result) => [result.id, result.score])));
        setSearchStatusKey("status.results");
      })
      .catch((err) => {
        // Stale/aborted requests (a newer query superseded this one, or unmount) are not
        // failures — bail silently before touching state.
        if (cancelled || controller.signal.aborted) return;
        if (process.env.NODE_ENV !== "production") {
          console.debug("[search] worker search failed, falling back to substring filter:", err);
        }
        // Offline/error fallback: clear the ranked map so visiblePosts degrades to its
        // cheap `searchable(post).includes(q)` substring branch over the already-loaded
        // posts — no lunr rebuild, no ML, search stays usable.
        setHybridResults(null);
        setSearchStatusKey("status.offline");
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debouncedQuery, posts.length, precision, lang]);

  const visiblePosts = useMemo(() => {
    const { text, operators } = parsedQuery;
    const q = text.trim().toLowerCase();
    const scoped = posts.filter((post) => {
      if (scope === "favorites") return favorites.has(post.id);
      if (scope === "articles") return Boolean(post.articleTitle);
      if (scope === "media") return Boolean(post.media?.length);
      if (scope === "photos") return post.media?.some((item) => item.type === "photo");
      if (scope === "videos") return post.media?.some((item) => item.type === "video" || item.type === "animated_gif");
      if (scope === "text") return !post.media?.length && !post.articleTitle;
      return true;
    });

    // T4.1: from:/before:/after: apply as hard filters BEFORE the text/hybrid filter below,
    // in BOTH precision modes identically (this step runs regardless of precision). Empty
    // residual text + active operators is a valid state — q is "" here, hybridResults is
    // null (the search effect below short-circuits on an empty residual), so `filtered`
    // falls through to `operatorScoped` unfiltered by text/hybrid, showing every
    // operator-matching post in the current sort order.
    const operatorScoped =
      operators.from || operators.before || operators.after
        ? scoped.filter((post) => {
            if (operators.from && post.author.screenName.toLowerCase() !== operators.from) return false;
            const postTime = byDate(post);
            if (operators.after && postTime < operators.after.getTime()) return false;
            if (operators.before && postTime >= operators.before.getTime()) return false;
            return true;
          })
        : scoped;

    const filtered = q
      ? hybridResults
        ? operatorScoped.filter((post) => hybridResults.has(post.id))
        : operatorScoped.filter((post) => searchable(post).includes(q))
      : operatorScoped;

    return [...filtered].sort((a, b) => {
      // T4.2: "relevance" only means score order while there's an active hybrid ranking to sort
      // by (q non-empty AND hybridResults populated). Every other sort value reorders WITHIN the
      // already-matched set using its own comparator, active search or not. "relevance" with no
      // active hybrid ranking (no search, or an operators-only search with an empty residual —
      // hybridResults is null there per the search effect above) falls through to the final
      // newest-first default below, same as "newest" itself.
      if (q && hybridResults && sort === "relevance") {
        return (hybridResults.get(b.id) ?? 0) - (hybridResults.get(a.id) ?? 0);
      }
      if (sort === "oldest") return byDate(a) - byDate(b);
      if (sort === "bookmarks") return (b.metrics?.bookmarks ?? 0) - (a.metrics?.bookmarks ?? 0);
      if (sort === "likes") return (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0);
      return byDate(b) - byDate(a);
    });
  }, [favorites, hybridResults, posts, parsedQuery, scope, sort]);

  // T4.1: human-readable stand-in for `query` at digest/chat call sites — residual text +
  // a parenthesized operator suffix, e.g. `agents (from:simonw, after:2026-03)`. Keeps
  // digest cache keys (lib/digest-cache.ts normalizes+keys off this string) distinct across
  // different operator combinations for the same residual text. The actual searched/shown
  // sources are already operator-filtered via visiblePosts above — this is display/cache-key
  // only, not a second filtering pass.
  const displayQuery = useMemo(() => {
    const { text, operators } = parsedQuery;
    const parts: string[] = [];
    if (operators.from) parts.push(`from:${operators.from}`);
    if (operators.after) parts.push(`after:${formatOperatorDate(operators.after)}`);
    if (operators.before) parts.push(`before:${formatOperatorDate(operators.before)}`);
    if (!parts.length) return text;
    const suffix = `(${parts.join(", ")})`;
    return text ? `${text} ${suffix}` : suffix;
  }, [parsedQuery]);

  // T4.1: removable chip descriptors for the active operators + any invalid tokens. Each
  // chip's ✕ does a surgical string removal on the raw `query` state (not the parsed
  // residual) so any other typed text survives untouched.
  const operatorChips = useMemo(() => {
    const { operators } = parsedQuery;
    const chips: Array<{ key: string; label: string; invalid?: boolean; title?: string; onRemove: () => void }> = [];
    if (operators.from) {
      chips.push({
        key: "op-from",
        label: `from: ${operators.from}`,
        onRemove: () => setQuery((current) => removeOperatorTokens(current, "from")),
      });
    }
    if (operators.after) {
      chips.push({
        key: "op-after",
        label: `after: ${formatOperatorDate(operators.after)}`,
        onRemove: () => setQuery((current) => removeOperatorTokens(current, "after")),
      });
    }
    if (operators.before) {
      chips.push({
        key: "op-before",
        label: `before: ${formatOperatorDate(operators.before)}`,
        onRemove: () => setQuery((current) => removeOperatorTokens(current, "before")),
      });
    }
    operators.invalid.forEach((entry, i) => {
      chips.push({
        key: `op-invalid-${i}-${entry.token}`,
        label: entry.token,
        invalid: true,
        title: entry.reason,
        onRemove: () => setQuery((current) => removeInvalidToken(current, entry.token)),
      });
    });
    return chips;
  }, [parsedQuery]);

  const displayedPosts = visiblePosts.slice(0, visibleLimit);

  // T4: no model download to report anymore — the status line is just the current search
  // phase (ready / searching… / results / offline fallback).
  const statusText = t(searchStatusKey);

  // Chat context snapshot taken whenever the chat opens. T4.1: uses displayQuery (residual
  // text + operator suffix) rather than the raw query, so the digest cache lookup key stays
  // distinct per operator combination — visiblePosts (sources) is already operator-filtered.
  const chatContext = useMemo<ChatContextSnapshot>(() => {
    return {
      language: lang,
      query: displayQuery || null,
      precision: displayQuery ? precision : null,
      sources: visiblePosts.slice(0, 20).map(toDigestSource),
      digest: displayQuery ? getDigest(displayQuery) : null,
      // 0 while the archive hasn't loaded yet reads as "unknown" server-side (falls back to
      // the static default text), same as omitting it entirely — see formatArchiveCount.
      archiveCount: posts.length || null,
    };
  }, [lang, displayQuery, precision, visiblePosts, posts.length]);

  // search_bookmarks tool executor — same Worker-backed search the live UI uses (ONE
  // search client, lib/search-client.ts), then maps ranked ids onto the already-loaded
  // posts. The content-type filter is applied client-side below, exactly as before.
  async function runChatSearch(input: SearchBookmarksInput): Promise<SearchBookmarksResult> {
    const q = input.query.trim();
    if (!q || posts.length === 0) return { count: 0, results: [] };
    let ranked: { id: string; score: number }[];
    try {
      // Do NOT pass input.limit through here: the content-type filter (article/media/text)
      // below runs client-side, AFTER this call, and slices to input.limit only at the end.
      // If we ask the Worker for only input.limit raw candidates, a filtered request (e.g.
      // filter:"article") has to draw from a much smaller pre-filter pool and can come back
      // starved. Let the Worker return its own generous default (DEFAULT_LIMIT = 240) so the
      // filter still has real headroom; the final `pool.slice(0, input.limit)` below still
      // caps the response to what the tool asked for.
      ranked = await searchViaWorker({ query: q, precision: input.precision });
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        console.debug("[chat-search] worker search failed, falling back to substring filter:", err);
      }
      // Same graceful degradation as the main search effect: cheap substring filter over
      // loaded posts (score 0 keeps the archive's natural order — good enough offline).
      const ql = q.toLowerCase();
      ranked = posts.filter((post) => searchable(post).includes(ql)).map((post) => ({ id: post.id, score: 0 }));
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
                setChatHistoryMessages(null);
                setChatOpen(true);
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
            <button
              type="button"
              onClick={handleSignOut}
              disabled={signingOut}
              className="flex items-center gap-1.5 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-3 py-2 text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)] disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={t("auth.signOut")}
              title={t("auth.signOut")}
            >
              <LogOut size={14} className="text-[color:var(--color-primary)]" />
              <span className="hidden sm:inline">{t("auth.signOut")}</span>
            </button>
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
                    setChatHistoryMessages(null);
                    setChatOpen(true);
                  }}
                  className="flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)]"
                >
                  <Sparkles size={16} className="text-[color:var(--color-primary)]" />
                  {t("chat.title")}
                </button>
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
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    void handleSignOut();
                  }}
                  disabled={signingOut}
                  className="mt-1 flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <LogOut size={16} className="text-[color:var(--color-primary)]" />
                  {t("auth.signOut")}
                </button>
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

        <AnimatePresence initial={false}>
          {operatorChips.length > 0 ? (
            <motion.div
              key="operator-chips"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="flex flex-wrap items-center gap-1.5"
            >
              {operatorChips.map((chip) => (
                <button
                  key={chip.key}
                  type="button"
                  onClick={chip.onRemove}
                  title={chip.title}
                  aria-label={t("search.operator.aria.remove", { label: chip.label })}
                  className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition ${
                    chip.invalid
                      ? "border-[color:var(--color-warning)]/40 bg-[color:var(--color-warning)]/10 text-[color:var(--color-warning)] hover:bg-[color:var(--color-warning)]/20"
                      : "border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-card)] hover:text-[color:var(--color-ink)]"
                  }`}
                >
                  <span>{chip.label}</span>
                  <XIcon size={10} />
                </button>
              ))}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 sm:gap-2">
          <OptionSelect
            value={sort}
            onValueChange={setSort}
            ariaLabel={t("sort.newest")}
            leadingIcon={<SlidersHorizontal size={14} />}
            className="h-9 px-2.5 text-[13px] sm:h-10 sm:px-3 sm:text-sm"
            options={[
              { value: "relevance", label: t("sort.relevance") },
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
              // T4.2: seed the restore-ref to "newest" too, so the query-transition effect
              // above (which will also fire from this same setQuery("")) restores "newest"
              // instead of clobbering this with whatever sort was active before the search.
              previousSortRef.current = "newest";
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
          {displayQuery && visiblePosts.length > 0 ? (
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
                disabled={digestSourcing}
                aria-busy={digestSourcing}
                onClick={async () => {
                  const query = displayQuery;
                  const fallback = visiblePosts.slice(0, DIGEST_SOURCE_LIMIT).map(toDigestSource);
                  let sources = fallback;
                  setDigestSourcing(true);
                  try {
                    // T1 (digest engine upgrade): re-query the Worker DEEP (limit 50,
                    // reranked) instead of clustering only the visible/on-screen posts —
                    // this is the whole point of the upgrade (actually use the search
                    // engine). Falls back to the visible slice on any failure/empty result.
                    const ranked = await searchViaWorker({ query, precision, limit: DIGEST_SOURCE_LIMIT });
                    const deep = ranked
                      .map((r) => postsById.get(r.id))
                      .filter((post): post is BookmarkPost => Boolean(post))
                      .map(toDigestSource);
                    if (deep.length > 0) sources = deep;
                  } catch (err) {
                    if (process.env.NODE_ENV !== "production") {
                      console.debug("[digest] worker re-query failed, falling back to visible posts:", err);
                    }
                  } finally {
                    setDigestSourcing(false);
                  }
                  setDigestPayload({ query, sources });
                  setDigestOpen(true);
                }}
                className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-[color:var(--color-primary)] px-5 text-sm font-medium text-[color:var(--color-on-primary)] transition-colors hover:bg-[color:var(--color-primary-active)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--color-primary)]/30 disabled:cursor-wait disabled:opacity-70"
              >
                <Sparkles size={16} className={digestSourcing ? "animate-pulse" : undefined} />
                <span>{t("action.aiDigest")}</span>
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => {
                  if (!displayQuery) return;
                  const prompt = t("chat.shortlistPrompt", { q: displayQuery });
                  setChatHistoryMessages(null);
                  setChatInitialPrompt(prompt);
                  setChatOpen(true);
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
