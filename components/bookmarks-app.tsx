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
    <main className="mx-auto min-h-screen w-[min(1240px,calc(100vw-32px))] py-8 md:py-12">
      <header className="grid gap-6 border-b-2 border-[#211d19] pb-6 md:grid-cols-[1fr_auto] md:items-end">
        <div>
          <p className="mb-3 max-w-xl text-sm font-bold uppercase tracking-[0.16em] text-[#c9432f]">
            X bookmarks, locally curated
          </p>
          <h1 className="max-w-3xl font-serif text-[clamp(44px,7vw,100px)] font-black leading-[0.86] tracking-normal">
            Claude Code Bookmarks
          </h1>
        </div>

        <section className="grid grid-cols-2 border border-[#211d19] bg-[#fffdf8] shadow-[0_18px_50px_rgba(33,29,25,0.08)] sm:grid-cols-4">
          <Stat value={posts.length} label="matches" />
          <Stat value={visiblePosts.length} label="visible" />
          <Stat value={favorites.size} label="starred" />
          <Stat value={payload?.metadata?.scanned_count ?? posts.length} label="scanned" />
        </section>
      </header>

      <section className="sticky top-0 z-10 my-5 grid gap-2 border border-[#211d19] bg-[#f7f1e6]/95 p-2 backdrop-blur md:grid-cols-[minmax(220px,1fr)_190px_160px_112px]">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#746b61]" size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-11 w-full rounded border border-[#211d19] bg-[#fffdf8] pl-10 pr-3 text-[#211d19] outline-none focus:ring-4 focus:ring-[#c9432f]/15"
            placeholder="Filter bookmarks"
            type="search"
          />
        </label>

        <label className="relative block">
          <SlidersHorizontal className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#746b61]" size={17} />
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className="min-h-11 w-full appearance-none rounded border border-[#211d19] bg-[#fffdf8] pl-10 pr-3 text-[#211d19] outline-none focus:ring-4 focus:ring-[#c9432f]/15"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="bookmarks">Most bookmarked</option>
            <option value="likes">Most liked</option>
          </select>
        </label>

        <label className="relative block">
          <Star className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#746b61]" size={17} />
          <select
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            className="min-h-11 w-full appearance-none rounded border border-[#211d19] bg-[#fffdf8] pl-10 pr-3 text-[#211d19] outline-none focus:ring-4 focus:ring-[#c9432f]/15"
          >
            <option value="all">All posts</option>
            <option value="favorites">Starred only</option>
          </select>
        </label>

        <button
          type="button"
          onClick={() => {
            setQuery("");
            setSort("newest");
            setScope("all");
          }}
          className="min-h-11 rounded border border-[#211d19] bg-[#fffdf8] px-3 font-extrabold text-[#211d19] transition hover:bg-[#211d19] hover:text-[#fffdf8]"
        >
          Clear
        </button>
      </section>

      <p className="mb-3 text-sm text-[#746b61]">
        {error ? error : `${number(visiblePosts.length)} of ${number(posts.length)} bookmarks from /data/claude-code-bookmarks.json`}
      </p>

      {error ? null : (
        <section className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4">
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
        <section className="border border-[#211d19] bg-[#fffdf8] p-10 text-center text-[#746b61]">
          No bookmarks match this filter.
        </section>
      ) : null}
    </main>
  );
}

function Stat({ value, label }: { value?: number; label: string }) {
  return (
    <div className="min-w-24 border-l border-[#d7cbbd] p-3 first:border-l-0">
      <strong className="block text-2xl leading-none">{number(value)}</strong>
      <span className="mt-1.5 block text-[11px] uppercase tracking-[0.08em] text-[#746b61]">{label}</span>
    </div>
  );
}
