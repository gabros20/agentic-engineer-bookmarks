"use client";

import { ArrowUp, Search, SlidersHorizontal, Sparkles, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BookmarkCard } from "@/components/bookmark-card";
import { DigestPanel } from "@/components/digest-panel";
import { SavedDigestsPanel } from "@/components/saved-digests-panel";
import { listSavedDigests, type SavedDigest } from "@/lib/digest-cache";
import { toDigestSource } from "@/lib/digest-source";
import type { DigestSource } from "@/lib/digest-schema";
import {
  applyRelativeFloor,
  buildKeywordIndex,
  expandSemanticQueries,
  keywordSearch,
  mergeHybridResults,
  multiVectorSearch,
  type SearchIndexPayload,
  type SearchPrecision,
} from "@/lib/bookmark-search";
import type { BookmarkPayload, BookmarkPost } from "@/lib/bookmark-types";

const FAVORITES_KEY = "agentic-engineer-bookmarks:favorites";
const SEARCH_DEBOUNCE_MS = 350;
const PAGE_SIZE = 240;

let extractorPromise: Promise<unknown> | null = null;

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

async function embedQueries(queries: string[], model: string) {
  const { pipeline } = await import("@huggingface/transformers");
  extractorPromise ??= pipeline("feature-extraction", model);
  const extractor = (await extractorPromise) as (
    text: string,
    options: { pooling: "mean"; normalize: boolean },
  ) => Promise<{ data: Iterable<number> }>;
  const embeddings: number[][] = [];

  for (const query of queries) {
    const output = await extractor(query, { pooling: "mean", normalize: true });
    embeddings.push(Array.from(output.data));
  }

  return embeddings;
}

export function BookmarksApp() {
  const [payload, setPayload] = useState<BookmarkPayload | null>(null);
  const [searchIndex, setSearchIndex] = useState<SearchIndexPayload | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [scope, setScope] = useState("all");
  const [precision, setPrecision] = useState<SearchPrecision>("exact");
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [hybridResults, setHybridResults] = useState<Map<string, number> | null>(null);
  const [searchStatus, setSearchStatus] = useState("Keyword search");
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

  useEffect(() => {
    setSavedCount(listSavedDigests().length);
  }, []);

  useEffect(() => {
    if (!savedOpen && !digestOpen) setSavedCount(listSavedDigests().length);
  }, [savedOpen, digestOpen]);

  useEffect(() => {
    setDigestUnlocked(document.cookie.split("; ").some((c) => c.startsWith("digest_ok=1")));
  }, []);

  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 400);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    fetch("/data/all-bookmarks.json")
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load bookmarks (${response.status})`);
        return response.json() as Promise<BookmarkPayload>;
      })
      .then(setPayload)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load bookmarks"));
  }, []);

  useEffect(() => {
    fetch("/data/search-index.json")
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load semantic index (${response.status})`);
        return response.json() as Promise<SearchIndexPayload>;
      })
      .then(setSearchIndex)
      .catch(() => setSearchStatus("Keyword search"));
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

  const posts = payload?.data ?? [];
  const keywordIndex = useMemo(() => (posts.length ? buildKeywordIndex(posts) : null), [posts]);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q || !keywordIndex) {
      setHybridResults(null);
      setSearchStatus(searchIndex ? "Semantic search ready" : "Keyword search");
      return;
    }

    let cancelled = false;
    const keywordResults = keywordSearch(keywordIndex, q);

    if (!searchIndex) {
      setHybridResults(new Map(keywordResults.map((result) => [result.id, result.score])));
      setSearchStatus("Keyword search");
      return;
    }

    const expandedQueries = expandSemanticQueries(q, precision);
    setSearchStatus(
      precision === "exact"
        ? "Exact semantic search warming up"
        : expandedQueries.length > 1
          ? "Broad semantic expansion warming up"
          : "Broad semantic search warming up",
    );

    embedQueries(expandedQueries, searchIndex.model)
      .then((embeddings) => {
        if (cancelled) return;
        const vectorResults = multiVectorSearch(searchIndex, embeddings).slice(0, 900);
        const merged = mergeHybridResults(keywordResults, vectorResults, precision);
        const finalResults = precision === "exact" ? applyRelativeFloor(merged, 0.5) : merged;
        setHybridResults(new Map(finalResults.map((result) => [result.id, result.score])));
        setSearchStatus(
          precision === "exact"
            ? "Exact hybrid search"
            : expandedQueries.length > 1
              ? "Broad hybrid expansion"
              : "Broad hybrid search",
        );
      })
      .catch(() => {
        if (cancelled) return;
        setHybridResults(new Map(keywordResults.map((result) => [result.id, result.score])));
        setSearchStatus("Keyword search");
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, keywordIndex, precision, searchIndex]);

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

  function toggleFavorite(id: string) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <main className="mx-auto min-h-screen w-full bg-[#f7f9f9]">
      <header className="sticky top-0 z-20 border-b border-[#eff3f4] bg-white/90 px-4 py-3 backdrop-blur-xl">
        <div className="flex w-full items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-extrabold leading-6 text-[#0f1419]">X Bookmarks</h1>
            <p className="text-[13px] leading-5 text-[#536471]">
              {number(posts.length)} saved posts searchable locally
            </p>
          </div>

          <div className="flex items-center gap-2">
            {digestUnlocked ? (
              <button
                type="button"
                onClick={() => setSavedOpen(true)}
                className="flex items-center gap-1.5 rounded-full border border-[#cfd9de] bg-white px-3 py-2 text-sm font-bold text-[#0f1419] transition hover:bg-[#eff3f4]"
                aria-label="Saved digests"
              >
                <Sparkles size={14} className="text-[#1d9bf0]" />
                {number(savedCount)}
              </button>
            ) : null}
            <div className="rounded-full bg-[#1d9bf0] px-4 py-2 text-sm font-bold text-white">
              {number(favorites.size)} starred
            </div>
          </div>
        </div>
      </header>

      <section className="grid w-full gap-3 border-b border-[#eff3f4] bg-white p-4">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#536471]" size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-11 w-full rounded-full border-0 bg-[#eff3f4] pl-11 pr-32 text-base text-[#0f1419] outline-none transition placeholder:text-[#536471] focus:bg-white focus:ring-2 focus:ring-[#1d9bf0]"
            placeholder="Filter bookmarks"
            type="search"
          />
          <div
            role="group"
            aria-label="Search precision"
            className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-full bg-white p-0.5 text-[11px] font-bold shadow-sm ring-1 ring-[#cfd9de]"
          >
            {(["exact", "broad"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setPrecision(value)}
                aria-pressed={precision === value}
                className={`min-h-8 rounded-full px-3 transition ${
                  precision === value
                    ? "bg-[#1d9bf0] text-white"
                    : "text-[#536471] hover:bg-[#eff3f4]"
                }`}
              >
                {value === "exact" ? "Exact" : "Broad"}
              </button>
            ))}
          </div>
        </label>

        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <label className="relative block">
            <SlidersHorizontal className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#536471]" size={16} />
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value)}
              className="min-h-10 w-full appearance-none rounded-full border border-[#cfd9de] bg-white pl-9 pr-3 text-sm font-semibold text-[#0f1419] outline-none focus:ring-2 focus:ring-[#1d9bf0]"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="bookmarks">Saves</option>
              <option value="likes">Likes</option>
            </select>
          </label>

          <label className="relative block">
            <Star className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#536471]" size={16} />
            <select
              value={scope}
              onChange={(event) => setScope(event.target.value)}
              className="min-h-10 w-full appearance-none rounded-full border border-[#cfd9de] bg-white pl-9 pr-3 text-sm font-semibold text-[#0f1419] outline-none focus:ring-2 focus:ring-[#1d9bf0]"
            >
              <option value="all">All saved</option>
              <option value="favorites">Starred</option>
              <option value="articles">Articles</option>
              <option value="media">Media</option>
              <option value="photos">Photos</option>
              <option value="videos">Videos</option>
              <option value="text">Text only</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() => {
              setQuery("");
              setSort("newest");
              setScope("all");
              setPrecision("exact");
            }}
            className="min-h-10 rounded-full border border-[#cfd9de] bg-white px-4 text-sm font-bold text-[#0f1419] transition hover:bg-[#eff3f4]"
          >
            Clear
          </button>
        </div>

        {digestUnlocked && query.trim() && visiblePosts.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              const sources = visiblePosts.slice(0, 30).map(toDigestSource);
              setDigestPayload({ query: query.trim(), sources });
              setDigestOpen(true);
            }}
            className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-[#1d9bf0] to-[#7856ff] px-4 text-sm font-bold text-white shadow-sm transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1d9bf0] focus-visible:ring-offset-2"
          >
            <Sparkles size={16} />
            <span>Digest top {Math.min(30, visiblePosts.length)} with AI</span>
          </button>
        ) : null}
      </section>

      <p className="w-full border-b border-[#eff3f4] bg-white px-4 py-3 text-sm text-[#536471]">
        {error
          ? error
          : `Showing ${number(displayedPosts.length)} of ${number(visiblePosts.length)} matching saved posts from /data/all-bookmarks.json · ${searchStatus}`}
      </p>

      {error ? null : (
        <section className="w-full columns-1 gap-4 p-4 sm:columns-[20rem]">
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
            className="min-h-11 rounded-full border border-[#cfd9de] bg-white px-5 text-sm font-bold text-[#0f1419] transition hover:bg-[#eff3f4]"
          >
            Load {number(Math.min(PAGE_SIZE, visiblePosts.length - displayedPosts.length))} more
          </button>
        </div>
      ) : null}

      {!error && visiblePosts.length === 0 ? (
        <section className="w-full p-12 text-center text-[#536471]">
          No bookmarks match this filter.
        </section>
      ) : null}

      {digestPayload ? (
        <DigestPanel
          open={digestOpen}
          query={digestPayload.query}
          sources={digestPayload.sources}
          initialCached={digestPayload.initialCached}
          onClose={() => setDigestOpen(false)}
        />
      ) : null}

      <SavedDigestsPanel
        open={savedOpen}
        onClose={() => setSavedOpen(false)}
        onOpenDigest={(saved) => {
          setDigestPayload({ query: saved.query, initialCached: saved });
          setSavedOpen(false);
          setDigestOpen(true);
        }}
      />

      <button
        type="button"
        aria-label="Scroll to top"
        onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        className={`fixed bottom-5 right-5 z-30 grid h-12 w-12 place-items-center rounded-full bg-[#1d9bf0] text-white shadow-lg ring-1 ring-black/5 transition-all hover:bg-[#1a8cd8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1d9bf0] focus-visible:ring-offset-2 ${
          showScrollTop ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        <ArrowUp size={20} />
      </button>
    </main>
  );
}
