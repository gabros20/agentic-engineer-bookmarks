// Build-time twin of lib/xrelay-archive.ts (kept in sync by hand).
// Shared by build-search-index.mjs, embed-new.mjs, and migrate-to-archive.mjs.
//
// Handles BOTH payload shapes:
//   - xrelay ArchiveFile:   { schema, source, generatedAt, count, tweets: [...] }
//   - legacy twitter-cli:   { ok, schema_version, metadata, data: [...] }

// ── xrelay ArchiveTweet -> app BookmarkPost (render/search shape) ─────────────

function mediaTypeIn(type) {
  // xrelay normalizes GIFs to 'gif'; the app/search expects 'animated_gif'.
  return type === "gif" ? "animated_gif" : type;
}

export function archiveTweetToBookmark(t) {
  const post = {
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
      type: mediaTypeIn(m.type),
      url: m.url,
      width: m.width,
      height: m.height,
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
      author: { screenName: t.quoted.author?.handle, name: t.quoted.author?.name },
    };
  }
  return post;
}

/** Accept either payload shape; return BookmarkPost[]. */
export function normalizeBookmarkPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.tweets)) return payload.tweets.map(archiveTweetToBookmark);
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

// ── app BookmarkPost -> xrelay ArchiveTweet (one-time legacy migration) ───────

function mediaTypeOut(type) {
  return type === "animated_gif" ? "gif" : type;
}

export function bookmarkToArchiveTweet(b) {
  const handle = b.author?.screenName ?? "";
  const t = {
    id: b.id,
    url: handle ? `https://x.com/${handle}/status/${b.id}` : `https://x.com/i/status/${b.id}`,
    text: b.text ?? "",
    author: {
      id: b.author?.id ?? "",
      handle,
      name: b.author?.name ?? "",
      verified: b.author?.verified ?? false,
    },
    metrics: b.metrics ?? {},
  };
  if (b.author?.profileImageUrl) t.author.avatar = b.author.profileImageUrl;
  if (b.lang) t.lang = b.lang;
  if (b.createdAt) t.createdAt = b.createdAt;
  if (b.createdAtISO) t.createdAtISO = b.createdAtISO;
  if (b.createdAtLocal) t.createdAtLocal = b.createdAtLocal;
  if (Array.isArray(b.urls) && b.urls.length) t.urls = b.urls;
  if (Array.isArray(b.media) && b.media.length) {
    t.media = b.media.map((m) => {
      const item = { type: mediaTypeOut(m.type), url: m.url };
      if (m.width !== undefined) item.width = m.width;
      if (m.height !== undefined) item.height = m.height;
      return item;
    });
  }
  if (b.isRetweet) t.isRetweet = true;
  if (b.retweetedBy) t.retweetedBy = b.retweetedBy;
  if (b.articleTitle) t.article = { title: b.articleTitle, markdown: b.articleText ?? "" };
  if (b.quotedTweet) {
    t.quoted = {
      id: b.quotedTweet.id ?? "",
      url: "",
      text: b.quotedTweet.text ?? "",
      author: {
        id: "",
        handle: b.quotedTweet.author?.screenName ?? "",
        name: b.quotedTweet.author?.name ?? "",
        verified: false,
      },
      metrics: {},
    };
  }
  return t;
}

/** Largest snowflake id by BigInt comparison (the archive's newestId). */
export function newestId(tweets) {
  let best;
  for (const t of tweets) {
    try {
      const id = BigInt(t.id);
      if (best === undefined || id > best.v) best = { v: id, s: t.id };
    } catch {
      // skip non-numeric ids
    }
  }
  return best?.s;
}

/** Wrap ArchiveTweet[] in the xrelay ArchiveFile envelope. */
export function buildArchiveFile(tweets, generatedAt) {
  const file = {
    schema: "x-relay/archive@1",
    source: "bookmarks",
    generatedAt,
    count: tweets.length,
    tweets,
  };
  const newest = newestId(tweets);
  if (newest) file.newestId = newest;
  return file;
}
