// Adapter between the xrelay `archive` output (xrelay-native rich `ArchiveFile`)
// and this app's `BookmarkPost` render shape.
//
// The data file on disk (public/data/all-bookmarks.json) is produced by
// `xrelay archive bookmarks --out ...` in xrelay-native shape:
//   { schema: "x-relay/archive@1", source, generatedAt, count, tweets: ArchiveTweet[] }
// while the app renders `BookmarkPost`. `normalizeBookmarkPayload` accepts EITHER
// the new xrelay shape (`.tweets`) or the legacy twitter-cli shape (`.data`), so
// the app keeps working across the migration and through future incremental syncs.
//
// Keep the field mapping in sync with scripts/lib/archive.mjs (build-time twin).

import type { BookmarkPost } from "@/lib/bookmark-types";

export type ArchiveMediaItem = {
  type?: string;
  url?: string;
  width?: number;
  height?: number;
  thumbnail?: string;
  bitrate?: number;
  durationMs?: number;
};

export type ArchiveAuthor = {
  id?: string;
  handle?: string;
  name?: string;
  verified?: boolean;
  followers?: number;
  avatar?: string;
};

export type ArchiveTweet = {
  id: string;
  url?: string;
  text: string;
  lang?: string;
  createdAt?: string;
  createdAtISO?: string;
  createdAtLocal?: string;
  author?: ArchiveAuthor;
  metrics?: BookmarkPost["metrics"];
  urls?: string[];
  media?: ArchiveMediaItem[];
  isRetweet?: boolean;
  retweetedBy?: string;
  quoted?: ArchiveTweet;
  article?: { title?: string; markdown?: string };
};

export type ArchiveFile = {
  schema?: string;
  source?: string;
  generatedAt?: string;
  count?: number;
  newestId?: string;
  tweets: ArchiveTweet[];
};

// xrelay normalizes GIFs to MediaKind 'gif'; the card renderer keys video/gif
// playback off the legacy 'animated_gif' value, so map it back on the way in.
function mediaType(type?: string): string | undefined {
  return type === "gif" ? "animated_gif" : type;
}

/** Map one xrelay-native ArchiveTweet to the app's BookmarkPost render shape. */
export function archiveTweetToBookmark(t: ArchiveTweet): BookmarkPost {
  const post: BookmarkPost = {
    id: t.id,
    text: t.text,
    author: {
      id: t.author?.id,
      name: t.author?.name ?? "",
      screenName: t.author?.handle ?? "",
      profileImageUrl: t.author?.avatar,
      verified: t.author?.verified,
    },
    metrics: t.metrics,
    createdAt: t.createdAt,
    createdAtLocal: t.createdAtLocal,
    createdAtISO: t.createdAtISO,
    media: (t.media ?? []).map((m) => ({
      type: mediaType(m.type),
      url: m.url,
      width: m.width,
      height: m.height,
      thumbnail: m.thumbnail,
      durationMs: m.durationMs,
    })),
    urls: t.urls,
    isRetweet: t.isRetweet,
    retweetedBy: t.retweetedBy ?? null,
    lang: t.lang,
  };
  if (t.article?.title) {
    post.articleTitle = t.article.title;
    if (t.article.markdown) post.articleText = t.article.markdown;
  }
  if (t.quoted) {
    post.quotedTweet = {
      id: t.quoted.id,
      text: t.quoted.text,
      author: {
        screenName: t.quoted.author?.handle,
        name: t.quoted.author?.name,
      },
    };
  }
  return post;
}

/**
 * Accept either the xrelay ArchiveFile (`.tweets`) or the legacy twitter-cli
 * payload (`.data`) and return BookmarkPost[]. Unknown/empty → [].
 */
export function normalizeBookmarkPayload(raw: unknown): BookmarkPost[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as { tweets?: unknown; data?: unknown };
  if (Array.isArray(obj.tweets)) {
    return (obj.tweets as ArchiveTweet[]).map(archiveTweetToBookmark);
  }
  if (Array.isArray(obj.data)) {
    return obj.data as BookmarkPost[];
  }
  return [];
}
