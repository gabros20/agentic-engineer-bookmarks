"use client";

import { ArrowUp, Search, SlidersHorizontal, Sparkles, Star } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { BookmarkCard } from "@/components/bookmark-card";
import { DigestPanel } from "@/components/digest-panel";
import { LanguageSwitcher } from "@/components/language-switcher";
import { SavedDigestsPanel } from "@/components/saved-digests-panel";
import { Select } from "@/components/ui/select";
import { UnlockForm } from "@/components/unlock-form";
import { listSavedDigests, type SavedDigest } from "@/lib/digest-cache";
import { toDigestSource } from "@/lib/digest-source";
import type { DigestSource } from "@/lib/digest-schema";
import { useLanguage } from "@/lib/i18n";
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
  const { t } = useLanguage();
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
      .catch(() => setSearchStatusKey("status.keyword"));
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
      setSearchStatusKey(searchIndex ? "status.semanticReady" : "status.keyword");
      return;
    }

    let cancelled = false;
    const keywordResults = keywordSearch(keywordIndex, q);

    if (!searchIndex) {
      setHybridResults(new Map(keywordResults.map((result) => [result.id, result.score])));
      setSearchStatusKey("status.keyword");
      return;
    }

    const expandedQueries = expandSemanticQueries(q, precision);
    setSearchStatusKey(
      precision === "exact"
        ? "status.exactWarming"
        : expandedQueries.length > 1
          ? "status.broadExpansionWarming"
          : "status.broadWarming",
    );

    embedQueries(expandedQueries, searchIndex.model)
      .then((embeddings) => {
        if (cancelled) return;
        const vectorResults = multiVectorSearch(searchIndex, embeddings).slice(0, 900);
        const merged = mergeHybridResults(keywordResults, vectorResults, precision);
        const finalResults = precision === "exact" ? applyRelativeFloor(merged, 0.5) : merged;
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
    <main className="mx-auto min-h-screen w-full bg-[color:var(--color-canvas)] text-[color:var(--color-body)]">
      <header className="sticky top-0 z-20 border-b border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)]/90 px-4 py-4 backdrop-blur-xl">
        <div className="flex w-full items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-[28px] leading-tight text-[color:var(--color-ink)] sm:text-[36px]">
              {t("app.title")}
            </h1>
            <p className="mt-1 text-[13px] leading-5 text-[color:var(--color-muted)]">
              {t("app.subtitle", { n: number(posts.length) })}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {digestUnlocked ? (
              <button
                type="button"
                onClick={() => setSavedOpen(true)}
                className="flex items-center gap-1.5 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-3 py-2 text-sm font-medium text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)]"
                aria-label={t("app.aria.savedDigests")}
              >
                <Sparkles size={14} className="text-[color:var(--color-primary)]" />
                {number(savedCount)}
                <span className="hidden sm:inline">{t("app.saved")}</span>
              </button>
            ) : null}
            <div className="rounded-md bg-[color:var(--color-primary)] px-3 py-2 text-sm font-medium text-[color:var(--color-on-primary)]">
              {number(favorites.size)} <span className="hidden sm:inline">{t("app.starred")}</span>
            </div>
            <LanguageSwitcher />
          </div>
        </div>
      </header>

      <section className="grid w-full gap-3 border-b border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-4">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[color:var(--color-muted)]" size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-11 w-full rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] pl-11 pr-32 text-base text-[color:var(--color-ink)] outline-none transition placeholder:text-[color:var(--color-muted)] focus:border-[color:var(--color-primary)] focus:ring-[3px] focus:ring-[color:var(--color-primary)]/15"
            placeholder={t("search.placeholder")}
            type="search"
          />
          <div
            role="group"
            aria-label={t("search.precision.aria")}
            className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-0.5 text-[11px] font-semibold"
          >
            {(["exact", "broad"] as const).map((value) => (
              <motion.button
                key={value}
                type="button"
                onClick={() => setPrecision(value)}
                aria-pressed={precision === value}
                whileTap={{ scale: 0.94 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className={`relative min-h-8 rounded-sm px-3 ${
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

        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          <Select
            value={sort}
            onValueChange={setSort}
            ariaLabel={t("sort.newest")}
            leadingIcon={<SlidersHorizontal size={14} />}
            options={[
              { value: "newest", label: t("sort.newest") },
              { value: "oldest", label: t("sort.oldest") },
              { value: "bookmarks", label: t("sort.bookmarks") },
              { value: "likes", label: t("sort.likes") },
            ]}
          />

          <Select
            value={scope}
            onValueChange={setScope}
            ariaLabel={t("scope.all")}
            leadingIcon={<Star size={14} />}
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
            className="min-h-10 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-4 text-sm font-medium text-[color:var(--color-ink)] transition-colors hover:bg-[color:var(--color-surface-card)]"
          >
            {t("action.clear")}
          </motion.button>
        </div>

        <AnimatePresence initial={false}>
          {query.trim() && visiblePosts.length > 0 ? (
            <motion.button
              key="ai-digest-cta"
              type="button"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
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
              className="flex min-h-11 items-center justify-center gap-2 rounded-md bg-[color:var(--color-primary)] px-5 text-sm font-medium text-[color:var(--color-on-primary)] transition-colors hover:bg-[color:var(--color-primary-active)] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-[color:var(--color-primary)]/30"
            >
              <Sparkles size={16} />
              <span>{t("action.aiDigest", { n: Math.min(30, visiblePosts.length) })}</span>
            </motion.button>
          ) : null}
        </AnimatePresence>
      </section>

      <p className="w-full border-b border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-4 py-3 text-sm text-[color:var(--color-muted)]">
        {error
          ? error
          : t("status.summary", {
              shown: number(displayedPosts.length),
              total: number(visiblePosts.length),
              status: t(searchStatusKey),
            })}
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
            }}
            onUnlocked={() => {
              setDigestUnlocked(true);
              setUnlockOpen(false);
              if (pendingDigest) {
                setDigestPayload(pendingDigest);
                setPendingDigest(null);
                setDigestOpen(true);
              }
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
