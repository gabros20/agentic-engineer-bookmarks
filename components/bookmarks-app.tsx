"use client";

import { Search, SlidersHorizontal, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BookmarkCard } from "@/components/bookmark-card";
import {
  buildKeywordIndex,
  keywordSearch,
  mergeHybridResults,
  type SearchIndexPayload,
  vectorSearch,
} from "@/lib/bookmark-search";
import type { BookmarkPayload, BookmarkPost } from "@/lib/bookmark-types";

const FAVORITES_KEY = "claude-code-bookmarks:favorites";
const SEARCH_DEBOUNCE_MS = 350;

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

async function embedQuery(query: string, model: string) {
  const { pipeline } = await import("@huggingface/transformers");
  extractorPromise ??= pipeline("feature-extraction", model);
  const extractor = (await extractorPromise) as (
    text: string,
    options: { pooling: "mean"; normalize: boolean },
  ) => Promise<{ data: Iterable<number> }>;
  const output = await extractor(query, { pooling: "mean", normalize: true });
  return Array.from(output.data);
}

export function BookmarksApp() {
  const [payload, setPayload] = useState<BookmarkPayload | null>(null);
  const [searchIndex, setSearchIndex] = useState<SearchIndexPayload | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [scope, setScope] = useState("all");
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [hybridResults, setHybridResults] = useState<Map<string, number> | null>(null);
  const [searchStatus, setSearchStatus] = useState("Keyword search");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/data/claude-code-bookmarks.json")
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

    setSearchStatus("Semantic search warming up");

    embedQuery(q, searchIndex.model)
      .then((embedding) => {
        if (cancelled) return;
        const vectorResults = vectorSearch(searchIndex, embedding);
        const merged = mergeHybridResults(keywordResults, vectorResults);
        setHybridResults(new Map(merged.map((result) => [result.id, result.score])));
        setSearchStatus("Hybrid semantic search");
      })
      .catch(() => {
        if (cancelled) return;
        setHybridResults(new Map(keywordResults.map((result) => [result.id, result.score])));
        setSearchStatus("Keyword search");
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, keywordIndex, searchIndex]);

  const visiblePosts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scoped = scope === "favorites" ? posts.filter((post) => favorites.has(post.id)) : posts;
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
            <h1 className="text-xl font-extrabold leading-6 text-[#0f1419]">Claude Code Bookmarks</h1>
            <p className="text-[13px] leading-5 text-[#536471]">
              {number(posts.length)} matches from {number(payload?.metadata?.scanned_count ?? posts.length)} saved posts
            </p>
          </div>

          <div className="rounded-full bg-[#1d9bf0] px-4 py-2 text-sm font-bold text-white">
            {number(favorites.size)} starred
          </div>
        </div>
      </header>

      <section className="grid w-full gap-3 border-b border-[#eff3f4] bg-white p-4">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#536471]" size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-11 w-full rounded-full border-0 bg-[#eff3f4] pl-11 pr-4 text-[15px] text-[#0f1419] outline-none transition placeholder:text-[#536471] focus:bg-white focus:ring-2 focus:ring-[#1d9bf0]"
            placeholder="Filter bookmarks"
            type="search"
          />
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
              <option value="all">All</option>
              <option value="favorites">Starred</option>
            </select>
          </label>

          <button
            type="button"
            onClick={() => {
              setQuery("");
              setSort("newest");
              setScope("all");
            }}
            className="min-h-10 rounded-full border border-[#cfd9de] bg-white px-4 text-sm font-bold text-[#0f1419] transition hover:bg-[#eff3f4]"
          >
            Clear
          </button>
        </div>
      </section>

      <p className="w-full border-b border-[#eff3f4] bg-white px-4 py-3 text-sm text-[#536471]">
        {error
          ? error
          : `${number(visiblePosts.length)} of ${number(posts.length)} bookmarks from /data/claude-code-bookmarks.json · ${searchStatus}`}
      </p>

      {error ? null : (
        <section className="w-full columns-1 gap-4 p-4 sm:columns-[20rem]">
          {visiblePosts.map((post) => (
            <BookmarkCard
              key={post.id}
              post={post}
              isFavorite={favorites.has(post.id)}
              onToggleFavorite={toggleFavorite}
            />
          ))}
        </section>
      )}

      {!error && visiblePosts.length === 0 ? (
        <section className="w-full p-12 text-center text-[#536471]">
          No bookmarks match this filter.
        </section>
      ) : null}
    </main>
  );
}
