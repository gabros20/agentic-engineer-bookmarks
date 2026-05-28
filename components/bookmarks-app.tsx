"use client";

import { Search, SlidersHorizontal, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BookmarkCard } from "@/components/bookmark-card";
import type { BookmarkPayload, BookmarkPost } from "@/lib/bookmark-types";

const FAVORITES_KEY = "claude-code-bookmarks:favorites";

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

export function BookmarksApp() {
  const [payload, setPayload] = useState<BookmarkPayload | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [scope, setScope] = useState("all");
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
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

  const posts = payload?.data ?? [];

  const visiblePosts = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scoped = scope === "favorites" ? posts.filter((post) => favorites.has(post.id)) : posts;
    const filtered = q ? scoped.filter((post) => searchable(post).includes(q)) : scoped;

    return [...filtered].sort((a, b) => {
      if (sort === "oldest") return byDate(a) - byDate(b);
      if (sort === "bookmarks") return (b.metrics?.bookmarks ?? 0) - (a.metrics?.bookmarks ?? 0);
      if (sort === "likes") return (b.metrics?.likes ?? 0) - (a.metrics?.likes ?? 0);
      return byDate(b) - byDate(a);
    });
  }, [favorites, posts, query, scope, sort]);

  function toggleFavorite(id: string) {
    setFavorites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <main className="mx-auto min-h-screen w-full max-w-[680px] border-x border-[#eff3f4] bg-white">
      <header className="sticky top-0 z-20 border-b border-[#eff3f4] bg-white/90 px-4 py-3 backdrop-blur-xl">
        <div className="flex items-start justify-between gap-4">
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

      <section className="grid gap-3 border-b border-[#eff3f4] bg-white p-4">
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

      <p className="border-b border-[#eff3f4] px-4 py-3 text-sm text-[#536471]">
        {error ? error : `${number(visiblePosts.length)} of ${number(posts.length)} bookmarks from /data/claude-code-bookmarks.json`}
      </p>

      {error ? null : (
        <section>
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
        <section className="p-12 text-center text-[#536471]">
          No bookmarks match this filter.
        </section>
      ) : null}
    </main>
  );
}
