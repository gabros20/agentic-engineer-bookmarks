"use client";

import { ArrowDownUp, ArrowUp, Bookmark as BookmarkIcon, Layers, ListOrdered, LogOut, MessagesSquare, MoreHorizontal, Search, SearchX, Sparkles, X as XIcon } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { BookmarkCard, estimateCardHeight, isMotionMedia } from "@/components/bookmark-card";
import { MasonryGrid, type MasonryEntry } from "@/components/masonry-grid";
import type { ChatContextSnapshot } from "@/components/command-k-chat";
import { LanguageSwitcher } from "@/components/language-switcher";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { OptionSelect } from "@/components/ui/select";
import { fetchSavedChats, readLegacyChats, type SavedChat } from "@/lib/chat-history";
import type {
  GetBookmarkInput,
  GetBookmarkResult,
  SearchBookmarksInput,
  SearchBookmarksResult,
} from "@/lib/chat-tools";
import { authClient } from "@/lib/auth-client";
import { fetchDigestByQuery, fetchSavedDigests, readLegacyDigests, type SavedDigest } from "@/lib/digest-cache";
import { toDigestSource } from "@/lib/digest-source";
import type { DigestSource } from "@/lib/digest-schema";
import { fetchQueryRewrites } from "@/lib/expand-client";
import type { DataWorkerMessage } from "@/lib/data-worker";
import { clearArchiveCache } from "@/lib/archive-cache";
import { useLanguage, type MessageKey } from "@/lib/i18n";
import { useTheme, type ThemePref } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { parseQueryOperators, removeInvalidToken, removeOperatorTokens } from "@/lib/query-operators";
import type { UIMessage } from "ai";
import { type SearchPrecision } from "@/lib/bookmark-search";
import type { BookmarkPost } from "@/lib/bookmark-types";
import {
  hasActiveOperators,
  matchesContentFilter,
  matchesOperators,
  postTime as byDate,
  searchable,
  toBookmarkDetail,
  toSearchHit,
} from "@/lib/bookmark-filters";
import { normalizeBookmarkPayload } from "@/lib/xrelay-archive";
import { searchViaWorker, SearchQuotaError } from "@/lib/search-client";

const FAVORITES_KEY = "agentic-engineer-bookmarks:favorites";
const SEARCH_DEBOUNCE_MS = 350;
// Cards rendered per page; infinite scroll adds more well before the end. Kept small because a
// new result set REMOUNTS every card (motion + images), which is what made typing heavy on phones.
const PAGE_SIZE = 48;
// T1 (digest engine upgrade): the digest CTA re-queries the Worker at this depth (deeper +
// reranked) instead of clustering the 30/PAGE_SIZE-limited posts currently on screen.
const DIGEST_SOURCE_LIMIT = 50;

// T6 (cross-device sync): one-shot import of any pre-T6 localStorage digests/chats into the
// DB. Runs once per browser (guarded by a `:migrated` flag), is non-destructive (localStorage
// is left intact as a fallback), and the server route is itself idempotent. A failure leaves
// the flag unset so it retries on the next load.
const MIGRATED_FLAG = "agentic-engineer-bookmarks:migrated";
async function migrateLegacyOnce() {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem(MIGRATED_FLAG)) return;
    const digests = readLegacyDigests();
    const chats = readLegacyChats();
    if (digests.length === 0 && chats.length === 0) {
      window.localStorage.setItem(MIGRATED_FLAG, "1");
      return;
    }
    const res = await fetch("/api/migrate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digests, chats }),
    });
    if (res.ok) window.localStorage.setItem(MIGRATED_FLAG, "1");
  } catch {
    // Leave the flag unset — the migration retries on the next load.
  }
}

const formatter = new Intl.NumberFormat("en");

function number(value?: number) {
  return formatter.format(value ?? 0);
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

// Open-on-demand panels are split out of the first-load bundle (it was 3.3 MB raw / 916 KB gzip,
// mostly the chat's Streamdown + mermaid/math/code renderers). The light ones are prefetched
// when the browser goes idle; the heavy chat on intent (hovering/focusing Ask, or ⌘K).
const loadDetail = () => import("@/components/bookmark-detail");
const loadChat = () => import("@/components/command-k-chat");
const loadDigest = () => import("@/components/digest-panel");
const loadSavedDigests = () => import("@/components/saved-digests-panel");
const loadSavedChats = () => import("@/components/saved-chats-panel");
const BookmarkDetail = dynamic(() => loadDetail().then((m) => m.BookmarkDetail), { ssr: false });
const CommandKChat = dynamic(() => loadChat().then((m) => m.CommandKChat), { ssr: false });
const DigestPanel = dynamic(() => loadDigest().then((m) => m.DigestPanel), { ssr: false });
const SavedDigestsPanel = dynamic(() => loadSavedDigests().then((m) => m.SavedDigestsPanel), { ssr: false });
const SavedChatsPanel = dynamic(() => loadSavedChats().then((m) => m.SavedChatsPanel), { ssr: false });

// Filter-rail scopes, in display order. ("media" = photos ∪ videos is still a valid `scope`
// value, it just isn't offered as a chip.)
const SCOPES: Array<{ value: string; label: MessageKey }> = [
  { value: "all", label: "chip.all" },
  { value: "favorites", label: "scope.favorites" },
  { value: "videos", label: "scope.videos" },
  { value: "photos", label: "scope.photos" },
  { value: "articles", label: "scope.articles" },
  { value: "text", label: "scope.text" },
];

function inScope(post: BookmarkPost, scope: string, favorites: Set<string>) {
  if (scope === "favorites") return favorites.has(post.id);
  if (scope === "articles") return Boolean(post.articleTitle);
  if (scope === "media") return Boolean(post.media?.length);
  if (scope === "photos") return Boolean(post.media?.some((item) => item.type === "photo"));
  if (scope === "videos") return Boolean(post.media?.some(isMotionMedia));
  if (scope === "text") return !post.media?.length && !post.articleTitle;
  return true;
}

// Header row height (h-16). The filter rail sticks right under it.
const HEADER_PX = 64;

const compactFormatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

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
  // The residual query text whose Worker search last finished (ranked OR failed). While the
  // current text differs, semantic results are still on their way: the grid shows the instant
  // substring matches plus a loader, and a previous query's ranking is never applied to it.
  const [settledQuery, setSettledQuery] = useState<string | null>(null);
  const [searchStatusKey, setSearchStatusKey] = useState<
    "status.ready" | "status.searching" | "status.results" | "status.offline" | "status.searchQuota"
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
  // T6: the previously-generated digest for the current query, fetched from the DB to enrich
  // the chat's context block. Replaces the old synchronous localStorage getDigest() lookup.
  const [contextDigest, setContextDigest] = useState<SavedDigest | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  // Detail sheet: the open post + which way we stepped into it (drives the slide direction).
  const [detail, setDetail] = useState<{ id: string; direction: number } | null>(null);
  const [scrolled, setScrolled] = useState(false);
  // True once the big hero search has slid under the header: the floating search takes over.
  const [condensed, setCondensed] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const floatingRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const pinResultsUntil = useRef(0);
  const heroRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { pref: themePref, setPref: setThemePref } = useTheme();
  const router = useRouter();

  // T3 login wall: sign out clears the Better Auth session, then routes to the
  // login screen (the server gate on / would redirect there anyway).
  async function handleSignOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await authClient.signOut();
      // The archive cached in IndexedDB is private data; don't leave it on the device after sign-out.
      await clearArchiveCache();
    } finally {
      router.replace("/login");
    }
  }

  // T6: header badge counts come from the DB (cross-device) — refreshed on mount (after the
  // one-shot localStorage migration) and again whenever a panel closes (a delete or save may
  // have changed them). M4 fix: both triggers share ONE seq-guarded refresher so two in-flight
  // fetches can't race — only the most-recently-STARTED fetch may write state, so a slow earlier
  // request (e.g. the mount fetch that waited on migration) can never clobber a fresher count.
  const countSeqRef = useRef(0);
  const refreshCounts = useCallback(async () => {
    const token = ++countSeqRef.current;
    try {
      const [digests, chats] = await Promise.all([fetchSavedDigests(), fetchSavedChats()]);
      if (token !== countSeqRef.current) return; // superseded by a newer refresh
      setSavedCount(digests.length);
      setSavedChatsCount(chats.length);
    } catch {
      // Leave counts as-is on failure.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      await migrateLegacyOnce();
      if (!alive) return;
      await refreshCounts();
    })();
    return () => {
      alive = false;
    };
  }, [refreshCounts]);

  useEffect(() => {
    if (savedOpen || digestOpen || chatOpen || chatHistoryOpen) return;
    void refreshCounts();
  }, [savedOpen, digestOpen, chatOpen, chatHistoryOpen, refreshCounts]);

  // One rAF-throttled scroll reader drives all scroll-dependent chrome. The floating search
  // condenses when the hero input slides under the header, with a 24px dead zone: the old
  // IntersectionObserver mount/unmount toggled back and forth at the edge (the flicker).
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      setShowScrollTop(y > 400);
      setScrolled(y > 8);
      const bottom = heroRef.current?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY;
      setCondensed((current) => (current ? bottom < HEADER_PX + 12 : bottom < HEADER_PX - 12));
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    // The user taking over the scroll releases a jump-to-results pin (see the effect below).
    const release = () => {
      pinResultsUntil.current = 0;
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchstart", release, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchstart", release);
    };
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
  //
  // Typing stays urgent and everything derived from the query runs on a DEFERRED copy: React
  // renders the keystroke first and computes/renders results as an interruptible background
  // render, so a slow results pass never delays the next character (notably on phones).
  const deferredQuery = useDeferredValue(query);
  const parsedQuery = useMemo(() => parseQueryOperators(deferredQuery), [deferredQuery]);

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
    // Searching/filtering from deep in the grid (floating search): bring the new top results
    // into view with the filter rail exactly in its stuck position under the header. No-op when
    // the grid top is already visible.
    // Measured after layout settles (two frames: rows above the grid, e.g. the AI actions, get
    // their height from motion a frame after commit) and again at 350ms. A jump "pins" the
    // results for 600ms so follow-up re-runs (a query auto-switches the sort to relevance) keep
    // them aligned; any wheel/touch from the user releases the pin.
    const align = () => {
      const grid = gridRef.current;
      if (!grid) return;
      const rail = railRef.current?.offsetHeight ?? 60;
      const top = Math.round(grid.getBoundingClientRect().top + window.scrollY - (HEADER_PX + rail));
      const pinned = performance.now() < pinResultsUntil.current;
      if (window.scrollY > top + 1 || (pinned && Math.abs(window.scrollY - top) > 1)) {
        window.scrollTo({ top, behavior: "instant" });
        pinResultsUntil.current = performance.now() + 600;
      }
    };
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(align);
    });
    const recheck = window.setTimeout(align, 350);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(recheck);
    };
  }, [deferredQuery, scope, sort]);

  const posts = useMemo(() => normalizeBookmarkPayload(payload), [payload]);

  // Built once per archive load, not per keystroke: the lowercased substring haystack (it joins
  // article bodies, so rebuilding it re-processed ~the whole 12 MB archive on every key) and the
  // post timestamp (the sort comparator used to re-parse date strings ~180k times per pass).
  const haystacks = useMemo(() => new Map(posts.map((post) => [post.id, searchable(post)])), [posts]);
  const timestamps = useMemo(() => new Map(posts.map((post) => [post.id, byDate(post)])), [posts]);

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
        // A results swap re-renders the grid: keep it a transition so typing preempts it.
        startTransition(() => {
          setHybridResults(new Map(results.map((result) => [result.id, result.score])));
          setSettledQuery(q);
          setSearchStatusKey("status.results");
        });
      })
      .catch((err) => {
        // Stale/aborted requests (a newer query superseded this one, or unmount) are not
        // failures — bail silently before touching state.
        if (cancelled || controller.signal.aborted) return;
        if (process.env.NODE_ENV !== "production") {
          console.debug("[search] worker search failed, falling back to substring filter:", err);
        }
        // Either way we clear the ranked map so visiblePosts degrades to its cheap
        // `searchable(post).includes(q)` substring branch over the already-loaded posts — no lunr
        // rebuild, no ML, search stays usable. Only the status message differs: a quota 429 gets a
        // distinct "daily limit reached" notice (non-blocking) instead of the generic offline copy,
        // so the user knows WHY results look basic rather than seeing silent degradation.
        setHybridResults(null);
        setSettledQuery(q);
        setSearchStatusKey(err instanceof SearchQuotaError ? "status.searchQuota" : "status.offline");
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [debouncedQuery, posts.length, precision, lang]);

  // Operator + text/hybrid matches, before the scope filter, so the filter rail can show how
  // many matches each scope holds. Filter steps commute, so this is the same set the old
  // scope-first pipeline produced.
  const textQuery = parsedQuery.text.trim();
  // Only a ranking computed for THIS text counts; a stale one (previous keystrokes) would show
  // the wrong results until the new search lands.
  const activeHybrid = hybridResults && settledQuery === textQuery ? hybridResults : null;
  const semanticPending = textQuery !== "" && payload !== null && settledQuery !== textQuery;

  const matchedPosts = useMemo(() => {
    const { text, operators } = parsedQuery;
    const q = text.trim().toLowerCase();

    // T4.1: from:/before:/after: apply as hard filters BEFORE the text/hybrid filter below,
    // in BOTH precision modes identically (this step runs regardless of precision). Empty
    // residual text + active operators is a valid state — q is "" here, hybridResults is
    // null (the search effect below short-circuits on an empty residual), so the result
    // falls through to `operatorScoped` unfiltered by text/hybrid, showing every
    // operator-matching post in the current sort order.
    // Filter semantics are shared with the server-side query layer (lib/bookmark-filters.ts).
    const operatorScoped = hasActiveOperators(operators)
      ? posts.filter((post) => matchesOperators(post, operators))
      : posts;

    return q
      ? activeHybrid
        ? operatorScoped.filter((post) => activeHybrid.has(post.id))
        : operatorScoped.filter((post) => haystacks.get(post.id)?.includes(q))
      : operatorScoped;
  }, [activeHybrid, posts, parsedQuery, haystacks]);

  const scopeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const { value } of SCOPES) counts[value] = 0;
    for (const post of matchedPosts) {
      for (const { value } of SCOPES) if (inScope(post, value, favorites)) counts[value]++;
    }
    return counts;
  }, [matchedPosts, favorites]);

  const visiblePosts = useMemo(() => {
    const q = parsedQuery.text.trim();
    const filtered = matchedPosts.filter((post) => inScope(post, scope, favorites));
    return filtered.sort((a, b) => {
      // T4.2: "relevance" only means score order while there's an active hybrid ranking to sort
      // by (q non-empty AND hybridResults populated). Every other sort value reorders WITHIN the
      // already-matched set using its own comparator, active search or not. "relevance" with no
      // active hybrid ranking (no search, or an operators-only search with an empty residual —
      // hybridResults is null there per the search effect above) falls through to the final
      // newest-first default below, same as "newest" itself.
      if (q && activeHybrid && sort === "relevance") {
        return (activeHybrid.get(b.id) ?? 0) - (activeHybrid.get(a.id) ?? 0);
      }
      if (sort === "oldest") return (timestamps.get(a.id) ?? 0) - (timestamps.get(b.id) ?? 0);
      if (sort === "bookmarks") return (b.metrics?.bookmarks ?? 0) - (a.metrics?.bookmarks ?? 0);
      if (sort === "likes") return (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0);
      return (timestamps.get(b.id) ?? 0) - (timestamps.get(a.id) ?? 0);
    });
  }, [favorites, activeHybrid, matchedPosts, parsedQuery, scope, sort, timestamps]);

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

  // T6: keep the chat's context digest in sync with the current query, from the DB.
  // I1 fix: fetch LAZILY — only while the chat panel is open. `contextDigest` feeds only
  // `chatContext` (consumed by CommandKChat, rendered only when `chatOpen`), and `displayQuery`
  // recomputes per keystroke, so the old unconditional effect ran a full user-digest scan on
  // every character typed. Gating on `chatOpen` means idle typing fires ZERO /api/digests
  // requests; the fetch runs when the chat opens (focus is trapped in the modal, so
  // `displayQuery` is stable while open — effectively fetch-on-open, with re-sync if it changes).
  useEffect(() => {
    if (!chatOpen || !displayQuery) {
      setContextDigest(null);
      return;
    }
    let alive = true;
    fetchDigestByQuery(displayQuery)
      .then((d) => {
        if (alive) setContextDigest(d);
      })
      .catch(() => {
        if (alive) setContextDigest(null);
      });
    return () => {
      alive = false;
    };
  }, [displayQuery, chatOpen]);

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
      digest: displayQuery ? contextDigest : null,
      // 0 while the archive hasn't loaded yet reads as "unknown" server-side (falls back to
      // the static default text), same as omitting it entirely — see formatArchiveCount.
      archiveCount: posts.length || null,
    };
  }, [lang, displayQuery, precision, visiblePosts, posts.length, contextDigest]);

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
      ranked = posts.filter((post) => haystacks.get(post.id)?.includes(ql)).map((post) => ({ id: post.id, score: 0 }));
    }
    const ids = new Set(ranked.map((r) => r.id));
    const score = new Map(ranked.map((r) => [r.id, r.score]));
    const pool = posts.filter((p) => ids.has(p.id) && matchesContentFilter(p, input.filter));
    pool.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0));
    const top = pool.slice(0, input.limit);
    return { count: top.length, results: top.map(toSearchHit) };
  }

  function getChatBookmark(input: GetBookmarkInput): GetBookmarkResult {
    const post = posts.find((p) => p.id === input.id);
    if (!post) return { found: false };
    return { found: true, bookmark: toBookmarkDetail(post) };
  }

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const openDetail = useCallback((id: string) => setDetail({ id, direction: 0 }), []);
  const closeDetail = useCallback(() => setDetail(null), []);
  const detailPost = detail ? postsById.get(detail.id) : undefined;
  const detailIndex = detail ? visiblePosts.findIndex((post) => post.id === detail.id) : -1;

  const stepDetail = useCallback(
    (delta: number) => {
      setDetail((current) => {
        if (!current) return current;
        const index = visiblePosts.findIndex((post) => post.id === current.id);
        const next = visiblePosts[index + delta];
        if (!next) return current;
        // Stepping past the rendered page grows it, so closing the sheet lands on a real card.
        if (index + delta >= visibleLimit) setVisibleLimit((limit) => limit + PAGE_SIZE);
        return { id: next.id, direction: delta };
      });
    },
    [visiblePosts, visibleLimit],
  );
  const prevDetail = useCallback(() => stepDetail(-1), [stepDetail]);
  const nextDetail = useCallback(() => stepDetail(1), [stepDetail]);

  const askAboutPost = useCallback(
    (post: BookmarkPost) => {
      setDetail(null);
      setChatHistoryMessages(null);
      setChatInitialPrompt(t("detail.askPrompt", { id: post.id, handle: post.author.screenName }));
      setChatOpen(true);
    },
    [t],
  );

  // Focus whichever search is on screen; the floating one searches in place (no jump to top).
  const focusSearch = useCallback(() => {
    (condensed ? floatingRef : searchRef).current?.focus({ preventScroll: true });
  }, [condensed]);

  useEffect(() => {
    const prefetch = () => {
      void loadDetail();
      void loadSavedDigests();
      void loadSavedChats();
      void loadDigest();
    };
    if ("requestIdleCallback" in window) {
      const handle = window.requestIdleCallback(prefetch, { timeout: 5000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = setTimeout(prefetch, 3000);
    return () => clearTimeout(timer);
  }, []);

  // "/" focuses the search from anywhere (unless typing or a panel is open).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input,textarea,[contenteditable=true]")) return;
      if (detail || chatOpen || digestOpen || savedOpen || chatHistoryOpen) return;
      event.preventDefault();
      focusSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, chatOpen, digestOpen, savedOpen, chatHistoryOpen, focusSearch]);

  // Infinite scroll: grow the rendered page well before the user reaches the end.
  const hasMore = visiblePosts.length > displayedPosts.length;
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisibleLimit((current) => current + PAGE_SIZE);
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, displayedPosts.length]);

  function resetFilters() {
    // T4.2: seed the restore-ref to "newest" too, so the query-transition effect
    // above (which will also fire from this same setQuery("")) restores "newest"
    // instead of clobbering this with whatever sort was active before the search.
    previousSortRef.current = "newest";
    setQuery("");
    setSort("newest");
    setScope("all");
    setPrecision("exact");
  }

  async function startDigest() {
    const digestQuery = displayQuery;
    const fallback = visiblePosts.slice(0, DIGEST_SOURCE_LIMIT).map(toDigestSource);
    let sources = fallback;
    setDigestSourcing(true);
    try {
      // T1 (digest engine upgrade): re-query the Worker DEEP (limit 50,
      // reranked) instead of clustering only the visible/on-screen posts —
      // this is the whole point of the upgrade (actually use the search
      // engine). Falls back to the visible slice on any failure/empty result.
      const ranked = await searchViaWorker({ query: digestQuery, precision, limit: DIGEST_SOURCE_LIMIT });
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
    setDigestPayload({ query: digestQuery, sources });
    setDigestOpen(true);
  }

  function openChat() {
    setChatHistoryMessages(null);
    setChatOpen(true);
  }

  const statusLine = error
    ? error
    : payload === null
      ? " "
      : semanticPending
        ? `${t("status.instant", { n: number(visiblePosts.length) })} · ${t("status.moreComing")}`
        : query.trim()
        ? `${t("status.matches", { n: number(visiblePosts.length) })} · ${statusText}`
        : scope === "all"
          ? t("status.count", { n: number(posts.length) })
          : t("status.matches", { n: number(visiblePosts.length) });

  const shell = "mx-auto w-full max-w-[1800px] px-3 sm:px-6 lg:px-10";

  const gridEntries: MasonryEntry[] = [
    ...(semanticPending ? [{ key: "search-loader", estimate: () => 200, render: () => <SearchLoaderCard /> }] : []),
    ...displayedPosts.map((post) => ({
      key: post.id,
      estimate: (width: number) => estimateCardHeight(post, width),
      render: () => (
        <BookmarkCard post={post} isFavorite={favorites.has(post.id)} onToggleFavorite={toggleFavorite} onOpen={openDetail} />
      ),
    })),
  ];

  return (
    <MotionConfig reducedMotion="user">
      <main className="min-h-screen w-full bg-[color:var(--color-page)] text-[color:var(--color-body)]">
        {/* ONE backdrop behind the header AND the filter rail (they used to blur separately and
            read as two stacked panels). Fixed under both: page color + blur, fading out downward. */}
        <div
          aria-hidden
          className={`pointer-events-none fixed inset-x-0 top-0 z-20 transition-opacity duration-500 ${scrolled ? "opacity-100" : "opacity-0"}`}
          style={{ height: "calc(env(safe-area-inset-top) + 9.75rem)" }}
        >
          <div className="absolute inset-0 backdrop-blur-xl [-webkit-mask-image:linear-gradient(to_bottom,#000_70%,transparent)] [mask-image:linear-gradient(to_bottom,#000_70%,transparent)]" />
          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,var(--color-page)_0%,color-mix(in_srgb,var(--color-page)_90%,transparent)_55%,transparent_100%)]" />
        </div>

        <header className="sticky top-0 z-30" style={{ paddingTop: "env(safe-area-inset-top)" }}>
          <div className={`${shell} relative flex h-16 items-center gap-2`}>
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="flex min-w-0 items-center gap-2 rounded-lg pr-1"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-[color:var(--color-primary)] text-[color:var(--color-on-primary)]">
                <BookmarkIcon size={14} fill="currentColor" />
              </span>
              <span
                className={`truncate font-display text-[21px] leading-none text-[color:var(--color-ink)] transition-opacity duration-300 ${
                  condensed ? "max-sm:opacity-0" : ""
                }`}
              >
                {t("app.title")}
              </span>
            </button>

            {/* Floating search: always mounted, so condensing is a pure opacity/translate/scale
                transition (compositor-only, no remount). Bound to the same query as the hero. */}
            <div
              aria-hidden={!condensed}
              className={`absolute left-[3.25rem] right-[5.75rem] top-[calc(50%-1.375rem)] h-11 transition-[opacity,translate,scale] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] sm:left-1/2 sm:right-auto sm:top-[calc(50%-1.5rem)] sm:h-12 sm:w-[min(40rem,46vw)] sm:-translate-x-1/2 ${
                condensed ? "translate-y-0 scale-100 opacity-100" : "pointer-events-none -translate-y-2 scale-[0.97] opacity-0"
              }`}
            >
              <div className="relative flex h-full items-center gap-2.5 overflow-hidden rounded-full bg-[color:var(--color-canvas)] pl-4 pr-1.5 shadow-[var(--shadow-float)] ring-1 ring-[color:var(--color-hairline)]/60 transition-shadow focus-within:ring-[color:var(--color-ink)]/25">
                <Search size={17} className="shrink-0 text-[color:var(--color-muted)]" />
                <input
                  ref={floatingRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      if (query) setQuery("");
                      else event.currentTarget.blur();
                    }
                  }}
                  type="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  tabIndex={condensed ? 0 : -1}
                  aria-label={t("search.placeholder")}
                  placeholder={posts.length ? t("search.hero", { n: number(posts.length) }) : t("search.placeholder")}
                  className="h-full min-w-0 flex-1 appearance-none bg-transparent font-display text-[18px] text-[color:var(--color-ink)] outline-none placeholder:italic placeholder:text-[color:var(--color-muted-soft)] sm:text-[21px] [&::-webkit-search-cancel-button]:hidden"
                />
                {query ? (
                  <button
                    type="button"
                    tabIndex={condensed ? 0 : -1}
                    onClick={() => {
                      setQuery("");
                      floatingRef.current?.focus();
                    }}
                    aria-label={t("search.clear")}
                    className="grid size-8 shrink-0 place-items-center rounded-full text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)]"
                  >
                    <XIcon size={15} />
                  </button>
                ) : (
                  <kbd className="mr-2 hidden shrink-0 rounded-md border border-[color:var(--color-hairline)] px-1.5 font-mono text-[11px] text-[color:var(--color-muted)] sm:block">/</kbd>
                )}
                <SearchSweep active={semanticPending && condensed} className="inset-x-6 bottom-0 h-[3px]" />
              </div>
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-1.5">
              <motion.button
                type="button"
                whileTap={{ scale: 0.95 }}
                onClick={openChat}
                onPointerEnter={() => void loadChat()}
                onFocus={() => void loadChat()}
                onTouchStart={() => void loadChat()}
                title={t("chat.openHint")}
                aria-label={t("nav.ask")}
                className={`flex h-9 items-center gap-1.5 rounded-full bg-[color:var(--color-primary)] pl-3 pr-3.5 text-sm font-medium text-[color:var(--color-on-primary)] transition-colors hover:bg-[color:var(--color-primary-active)] ${
                  condensed ? "max-sm:px-2.5" : ""
                }`}
              >
                <Sparkles size={14} />
                <span className={condensed ? "max-sm:hidden" : undefined}>{t("nav.ask")}</span>
                <kbd className="ml-0.5 hidden rounded bg-[color:var(--color-on-primary)]/15 px-1.5 py-px font-mono text-[10px] lg:inline">⌘K</kbd>
              </motion.button>

              <HeaderIconButton label={t("nav.digests")} count={savedCount} onClick={() => setSavedOpen(true)} className="hidden sm:grid">
                <Layers size={17} />
              </HeaderIconButton>
              <HeaderIconButton label={t("nav.chats")} count={savedChatsCount} onClick={() => setChatHistoryOpen(true)} className="hidden sm:grid">
                <MessagesSquare size={17} />
              </HeaderIconButton>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("nav.menu")}
                    className="grid size-9 place-items-center rounded-full text-[color:var(--color-ink)] outline-none transition hover:bg-[color:var(--color-surface-cream-strong)] focus-visible:ring-2 focus-visible:ring-[color:var(--color-ink)]"
                  >
                    <MoreHorizontal size={18} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" sideOffset={8} className="w-56 rounded-xl border-[color:var(--color-hairline)] p-1.5 shadow-[var(--shadow-float)]">
                  <DropdownMenuItem className="gap-2.5 rounded-lg py-2 sm:hidden" onSelect={() => setSavedOpen(true)}>
                    <Layers size={15} />
                    <span className="flex-1">{t("nav.digests")}</span>
                    {savedCount ? <span className="text-xs tabular-nums text-[color:var(--color-muted)]">{number(savedCount)}</span> : null}
                  </DropdownMenuItem>
                  <DropdownMenuItem className="gap-2.5 rounded-lg py-2 sm:hidden" onSelect={() => setChatHistoryOpen(true)}>
                    <MessagesSquare size={15} />
                    <span className="flex-1">{t("nav.chats")}</span>
                    {savedChatsCount ? <span className="text-xs tabular-nums text-[color:var(--color-muted)]">{number(savedChatsCount)}</span> : null}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator className="sm:hidden" />
                  <DropdownMenuLabel className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-[color:var(--color-muted)]">
                    {t("theme.label")}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup value={themePref} onValueChange={(value) => setThemePref(value as ThemePref)}>
                    {(["system", "light", "dark"] as const).map((value) => (
                      <DropdownMenuRadioItem key={value} value={value} className="rounded-lg py-2">
                        {t(`theme.${value}`)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <div className="flex items-center justify-between gap-3 px-2 py-1.5">
                    <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-[color:var(--color-muted)]">{t("lang.label")}</span>
                    <LanguageSwitcher />
                  </div>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem className="gap-2.5 rounded-lg py-2" disabled={signingOut} onSelect={() => void handleSignOut()}>
                    <LogOut size={15} />
                    {t("auth.signOut")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <section className={`${shell} pt-5 sm:pt-10`}>
          <div ref={heroRef} className="relative">
            <label htmlFor="hero-search" className="sr-only">
              {t("search.placeholder")}
            </label>
            <input
              id="hero-search"
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  if (query) setQuery("");
                  else event.currentTarget.blur();
                }
              }}
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={posts.length ? t("search.hero", { n: number(posts.length) }) : t("search.placeholder")}
              className="w-full appearance-none rounded-none border-b border-[color:var(--color-hairline)] bg-transparent pb-3 pr-11 font-display text-[32px] leading-[1.15] text-[color:var(--color-ink)] caret-[color:var(--color-ink)] outline-none transition-colors duration-300 placeholder:italic placeholder:text-[color:var(--color-muted-soft)] focus:border-[color:var(--color-ink)] sm:text-[52px] lg:text-[60px] [&::-webkit-search-cancel-button]:hidden"
            />
            <SearchSweep active={semanticPending} className="inset-x-0 -bottom-[2px]" />
            <div className="absolute bottom-3.5 right-0 sm:bottom-5">
              <AnimatePresence mode="wait" initial={false}>
                {query ? (
                  <motion.button
                    key="clear"
                    type="button"
                    initial={{ opacity: 0, scale: 0.7 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.7 }}
                    transition={{ duration: 0.15 }}
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                    aria-label={t("search.clear")}
                    className="grid size-9 place-items-center rounded-full bg-[color:var(--color-canvas)] text-[color:var(--color-ink)] shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition hover:bg-[color:var(--color-surface-cream-strong)]"
                  >
                    <XIcon size={16} />
                  </motion.button>
                ) : (
                  <motion.kbd
                    key="slash"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="hidden rounded-md border border-[color:var(--color-hairline)] px-2 py-0.5 font-mono text-xs text-[color:var(--color-muted)] sm:block"
                  >
                    /
                  </motion.kbd>
                )}
              </AnimatePresence>
            </div>
          </div>

          <AnimatePresence initial={false}>
            {operatorChips.length > 0 ? (
              <motion.div
                key="operator-chips"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="flex flex-wrap items-center gap-1.5 overflow-hidden pt-3"
              >
                {operatorChips.map((chip) => (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={chip.onRemove}
                    title={chip.title}
                    aria-label={t("search.operator.aria.remove", { label: chip.label })}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-xs transition ${
                      chip.invalid
                        ? "bg-[color:var(--color-warning)]/12 text-[color:var(--color-warning)] hover:bg-[color:var(--color-warning)]/20"
                        : "bg-[color:var(--color-canvas)] text-[color:var(--color-body)] hover:bg-[color:var(--color-surface-cream-strong)]"
                    }`}
                  >
                    <span>{chip.label}</span>
                    <XIcon size={11} />
                  </button>
                ))}
              </motion.div>
            ) : null}
          </AnimatePresence>

          <div className="mt-3 flex min-h-8 items-center justify-between gap-3">
            <p aria-live="polite" className={`truncate text-[13px] tabular-nums ${error ? "text-[color:var(--color-error)]" : "text-[color:var(--color-muted)]"}`}>
              {semanticPending ? <span className="search-loader-text">{statusLine}</span> : statusLine}
            </p>
            <PrecisionToggle value={precision} onChange={setPrecision} />
          </div>

          <AnimatePresence initial={false}>
            {displayQuery && visiblePosts.length > 0 ? (
              <motion.div
                key="ai-ctas"
                // Scrolled away (floating search in use) it appears/disappears instantly: an
                // animated height change above the grid would push the results down after the
                // jump-to-results scroll has already measured them.
                initial={condensed ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={condensed ? { opacity: 0, height: 0, transition: { duration: 0 } } : { opacity: 0, height: 0 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <div className="flex gap-2 pb-1 pt-4">
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.97 }}
                    disabled={digestSourcing}
                    aria-busy={digestSourcing}
                    onClick={() => void startDigest()}
                    className="flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-[color:var(--color-primary)] px-4 text-sm font-medium text-[color:var(--color-on-primary)] transition-colors hover:bg-[color:var(--color-primary-active)] disabled:cursor-wait disabled:opacity-70 sm:flex-none"
                  >
                    <Sparkles size={15} className={digestSourcing ? "animate-pulse" : undefined} />
                    {t("action.aiDigest")}
                  </motion.button>
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.97 }}
                    onClick={() => {
                      setChatHistoryMessages(null);
                      setChatInitialPrompt(t("chat.shortlistPrompt", { q: displayQuery }));
                      setChatOpen(true);
                    }}
                    className="flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-[color:var(--color-canvas)] px-4 text-sm font-medium text-[color:var(--color-ink)] shadow-[0_1px_2px_rgb(0_0_0/0.04)] ring-1 ring-inset ring-[color:var(--color-hairline)] transition hover:bg-[color:var(--color-surface-soft)] sm:flex-none"
                  >
                    <ListOrdered size={15} />
                    {t("action.aiShortlist")}
                  </motion.button>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>

        <nav
          aria-label={t("scope.all")}
          ref={railRef}
          className="sticky z-30"
          style={{ top: "calc(4rem + env(safe-area-inset-top))" }}
        >
          <div className={`${shell} flex items-center gap-2 py-3`}>
            <div className="no-scrollbar -mx-3 flex min-w-0 flex-1 snap-x scroll-px-3 items-center gap-1.5 overflow-x-auto px-3 [mask-image:linear-gradient(to_right,#000_calc(100%-2rem),transparent)] sm:mx-0 sm:scroll-px-0 sm:px-0 sm:[mask-image:none]">
              {SCOPES.filter(({ value }) => value === "all" || value === scope || scopeCounts[value] > 0).map(({ value, label }) => {
                const active = scope === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setScope(value)}
                    aria-pressed={active}
                    // Plain CSS color transition, not a motion layoutId pill: the counts change on
                    // every keystroke, and layout projection re-measured the page each time.
                    className={`relative flex h-9 shrink-0 snap-start items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-[background-color,color] duration-200 ${
                      active
                        ? "bg-[color:var(--color-primary)] text-[color:var(--color-on-primary)]"
                        : "bg-[color:var(--color-canvas)] text-[color:var(--color-body-strong)] shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:bg-[color:var(--color-surface-cream-strong)]"
                    }`}
                  >
                    <span className="relative">{t(label)}</span>
                    {payload !== null ? (
                      <span className="relative text-[11px] tabular-nums opacity-55">{compactFormatter.format(scopeCounts[value] ?? 0)}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <OptionSelect
              value={sort}
              onValueChange={setSort}
              ariaLabel={t("sort.newest")}
              leadingIcon={<ArrowDownUp size={14} />}
              className="h-9 w-auto shrink-0 gap-1.5 rounded-full border-0 bg-[color:var(--color-canvas)] pl-3 pr-2 text-[13px] font-medium shadow-[0_1px_2px_rgb(0_0_0/0.04)] hover:bg-[color:var(--color-canvas)] hover:text-[color:var(--color-ink)]"
              options={[
                { value: "relevance", label: t("sort.relevance") },
                { value: "newest", label: t("sort.newest") },
                { value: "oldest", label: t("sort.oldest") },
                { value: "bookmarks", label: t("sort.bookmarks") },
                { value: "likes", label: t("sort.likes") },
              ]}
            />
          </div>
        </nav>

        {error ? null : payload === null ? (
          <section aria-busy="true" className={`${shell} pb-10 pt-1`}>
            <MasonryGrid entries={skeletonEntries} />
          </section>
        ) : visiblePosts.length === 0 && !semanticPending ? (
          <motion.section
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className={`${shell} grid justify-items-center gap-3 py-20 text-center`}
          >
            <span className="grid size-12 place-items-center rounded-full bg-[color:var(--color-canvas)] text-[color:var(--color-muted)]">
              <SearchX size={20} />
            </span>
            <p className="text-[15px] text-[color:var(--color-muted)]">{t("empty.results")}</p>
            <button
              type="button"
              onClick={resetFilters}
              className="h-10 rounded-full bg-[color:var(--color-canvas)] px-5 text-sm font-medium text-[color:var(--color-ink)] shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition hover:bg-[color:var(--color-surface-soft)]"
            >
              {t("action.clear")}
            </button>
          </motion.section>
        ) : (
          <section ref={gridRef} className={`${shell} pb-10 pt-1`}>
            <MasonryGrid entries={gridEntries} />
          </section>
        )}

        {!error && hasMore ? (
          <div ref={sentinelRef} className="grid w-full place-items-center px-4 pb-12">
            <button
              type="button"
              onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}
              className="h-10 rounded-full bg-[color:var(--color-canvas)] px-5 text-sm font-medium text-[color:var(--color-ink)] shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition hover:bg-[color:var(--color-surface-soft)]"
            >
              {t("action.loadMore", { n: number(Math.min(PAGE_SIZE, visiblePosts.length - displayedPosts.length)) })}
            </button>
          </div>
        ) : null}

        <AnimatePresence>
          {detail && detailPost ? (
            <BookmarkDetail
              key="detail"
              post={detailPost}
              index={detailIndex}
              total={visiblePosts.length}
              direction={detail.direction}
              isFavorite={favorites.has(detailPost.id)}
              onToggleFavorite={toggleFavorite}
              onClose={closeDetail}
              onPrev={prevDetail}
              onNext={nextDetail}
              onAsk={askAboutPost}
            />
          ) : null}
        </AnimatePresence>

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
          {showScrollTop && !detail ? (
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
              style={{ bottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
              className="fixed right-4 z-30 grid size-11 place-items-center rounded-full bg-[color:var(--color-primary)] text-[color:var(--color-on-primary)] shadow-[var(--shadow-float)] transition-colors hover:bg-[color:var(--color-primary-active)] sm:right-6"
            >
              <ArrowUp size={18} />
            </motion.button>
          ) : null}
        </AnimatePresence>
      </main>
    </MotionConfig>
  );
}

// Memoized so its layoutId pill is only measured when the mode actually changes, not on every
// keystroke re-render of the app shell.
const PrecisionToggle = memo(function PrecisionToggle({
  value: current,
  onChange,
}: {
  value: SearchPrecision;
  onChange: (value: SearchPrecision) => void;
}) {
  const { t } = useLanguage();
  return (
    <div
      role="group"
      aria-label={t("search.precision.aria")}
      className="flex shrink-0 items-center rounded-full bg-[color:var(--color-surface-cream-strong)]/70 p-0.5 text-xs font-medium"
    >
      {(["exact", "broad"] as const).map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => onChange(value)}
          aria-pressed={current === value}
          className={`relative h-7 rounded-full px-3 transition-colors ${
            current === value ? "text-[color:var(--color-ink)]" : "text-[color:var(--color-muted)] hover:text-[color:var(--color-ink)]"
          }`}
        >
          {current === value ? (
            <motion.span
              layoutId="precision-active"
              className="absolute inset-0 rounded-full bg-[color:var(--color-canvas)] shadow-sm"
              transition={{ type: "spring", stiffness: 500, damping: 40 }}
            />
          ) : null}
          <span className="relative">{value === "exact" ? t("search.precision.exact") : t("search.precision.broad")}</span>
        </button>
      ))}
    </div>
  );
});

function HeaderIconButton({
  label,
  count,
  onClick,
  className,
  children,
}: {
  label: string;
  count: number;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={count ? `${label} (${count})` : label}
      title={label}
      onClick={onClick}
      className={`relative size-9 place-items-center rounded-full text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-cream-strong)] ${className ?? "grid"}`}
    >
      {children}
      {count ? (
        <span className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-[color:var(--color-primary)] px-1 text-[9px] font-semibold tabular-nums text-[color:var(--color-on-primary)]">
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </button>
  );
}

// mymind-style "more is coming" card: sits at the top of the grid while the Worker's semantic
// ranking is in flight, so the instant substring matches below read as a first pass.
function SearchLoaderCard() {
  const { t } = useLanguage();
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      role="status"
      className="search-loader-card grid w-full place-items-center gap-1.5 rounded-2xl px-4 py-8 text-center sm:py-10"
    >
      <motion.span
        animate={{ rotate: [0, 18, -12, 0], scale: [1, 1.12, 1] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        className="text-[color:var(--color-ink)]"
      >
        <Sparkles size={20} />
      </motion.span>
      <p className="font-display text-[22px] leading-tight text-[color:var(--color-ink)] sm:text-[24px]">{t("loader.title")}</p>
      <p className="max-w-[15rem] text-[12.5px] leading-[1.45] text-[color:var(--color-muted)]">{t("loader.body")}</p>
    </motion.div>
  );
}

const SKELETON_HEIGHTS = [260, 170, 300, 210, 240, 190];
const skeletonEntries: MasonryEntry[] = Array.from({ length: 12 }, (_, index) => ({
  key: `skeleton-${index}`,
  estimate: () => SKELETON_HEIGHTS[index % SKELETON_HEIGHTS.length],
  render: () => <CardSkeleton index={index} />,
}));

function CardSkeleton({ index }: { index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: index * 0.035, duration: 0.3 }}
      className="block w-full overflow-hidden rounded-2xl bg-[color:var(--color-canvas)]"
    >
      <div className="animate-pulse bg-[color:var(--color-surface-card)]" style={{ height: SKELETON_HEIGHTS[index % SKELETON_HEIGHTS.length] - 70 }} />
      <div className="grid gap-2 p-3 sm:p-4">
        <div className="h-3 w-4/5 animate-pulse rounded-full bg-[color:var(--color-surface-cream-strong)]" />
        <div className="h-3 w-3/5 animate-pulse rounded-full bg-[color:var(--color-surface-cream-strong)]" />
      </div>
    </motion.div>
  );
}

// The semantic-search progress bar: swells from a hairline with scaleY and breathes while the
// ranking is in flight; the light inside sweeps with translateX. Transform/opacity only (GPU),
// absolutely positioned, so it never moves layout.
function SearchSweep({ active, className }: { active: boolean; className?: string }) {
  return (
    <AnimatePresence>
      {active ? (
        <motion.span
          key="sweep"
          aria-hidden
          initial={{ opacity: 0, scaleY: 0.25 }}
          animate={{ opacity: 1, scaleY: [1, 0.65, 1] }}
          exit={{ opacity: 0, scaleY: 0.25, transition: { duration: 0.25, ease: "easeOut" } }}
          transition={{ opacity: { duration: 0.2 }, scaleY: { duration: 1.4, repeat: Infinity, ease: "easeInOut" } }}
          className={cn(
            "pointer-events-none absolute h-1 overflow-hidden rounded-full bg-[color:var(--color-ink)]/10 will-change-transform",
            className,
          )}
        >
          <span className="search-loader-sweep absolute inset-y-0 left-0 w-[45%] rounded-full" />
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}
