import type { BookmarkPost } from "@/lib/bookmark-types";
import type { GetBookmarkResult, SearchBookmarksInput, SearchBookmarksResult } from "@/lib/chat-tools";
import type { QueryOperators } from "@/lib/query-operators";
import { threadText } from "@/lib/thread-text";

// ---------------------------------------------------------------------------
// Pure post filters + tool-result mappers, shared by the browser UI
// (components/bookmarks-app.tsx: visiblePosts, the ⌘K chat tool executors) and
// the server-side query layer (lib/server/bookmark-service.ts, which backs the
// MCP server). Before this module these lived inline in bookmarks-app.tsx, so a
// non-browser caller could not apply `from:`/`before:`/`after:` or the
// content-type filter at all. Semantics are UNCHANGED — moved, not rewritten.
// No React, no Node APIs: safe to import from both sides.
// ---------------------------------------------------------------------------

export type ContentFilter = SearchBookmarksInput["filter"];

/** Post timestamp in ms (createdAtISO preferred, then createdAt, else epoch 0). */
export function postTime(post: BookmarkPost): number {
  return new Date(post.createdAtISO ?? post.createdAt ?? 0).getTime();
}

/**
 * Lowercased haystack for the cheap substring fallback used when the search Worker is
 * unreachable (UI offline mode, and the server-side degraded path).
 */
export function searchable(post: BookmarkPost): string {
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
    threadText(post),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function hasActiveOperators(operators: Pick<QueryOperators, "from" | "before" | "after">): boolean {
  return Boolean(operators.from || operators.before || operators.after);
}

/**
 * T4.1 operator semantics: `from` = exact (lowercased) screenName match; `after` inclusive
 * lower bound; `before` EXCLUSIVE upper bound — see lib/query-operators.ts.
 */
export function matchesOperators(
  post: BookmarkPost,
  operators: Pick<QueryOperators, "from" | "before" | "after">,
): boolean {
  if (operators.from && post.author.screenName.toLowerCase() !== operators.from) return false;
  const time = postTime(post);
  if (operators.after && time < operators.after.getTime()) return false;
  if (operators.before && time >= operators.before.getTime()) return false;
  return true;
}

/** The chat/MCP content-type filter (not the UI's richer `scope` selector). */
export function matchesContentFilter(post: BookmarkPost, filter: ContentFilter | undefined): boolean {
  if (filter === "article") return Boolean(post.articleTitle || post.articleText);
  if (filter === "media") return (post.media?.length ?? 0) > 0;
  if (filter === "text") return !post.media?.length;
  return true;
}

export function postUrl(post: BookmarkPost): string {
  return `https://x.com/${post.author?.screenName ?? "i"}/status/${post.id}`;
}

/** One compact search hit (text capped at 280 chars) — the search_bookmarks tool row. */
export function toSearchHit(post: BookmarkPost): SearchBookmarksResult["results"][number] {
  return {
    id: post.id,
    author: post.author?.name ?? post.author?.screenName ?? "",
    screenName: post.author?.screenName ?? "",
    text: (post.text ?? "").slice(0, 280),
    articleTitle: post.articleTitle,
    url: postUrl(post),
    createdAt: post.createdAtISO ?? post.createdAt,
    likes: post.metrics?.likes,
    bookmarks: post.metrics?.bookmarks,
  };
}

/** The full bookmark (incl. X Article body) — the get_bookmark tool payload. */
export function toBookmarkDetail(post: BookmarkPost): NonNullable<GetBookmarkResult["bookmark"]> {
  return {
    id: post.id,
    author: post.author?.name ?? post.author?.screenName ?? "",
    screenName: post.author?.screenName ?? "",
    text: post.text ?? "",
    articleTitle: post.articleTitle,
    articleText: post.articleText,
    ...(post.thread?.length ? { thread: post.thread.map((p) => p.text ?? "") } : {}),
    url: postUrl(post),
    createdAt: post.createdAtISO ?? post.createdAt,
    metrics: post.metrics,
  };
}
