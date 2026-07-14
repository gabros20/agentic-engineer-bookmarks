// Shared embedding helpers for build-search-index.mjs (full rebuild) and
// embed-new.mjs (incremental). Keep searchText identical across both so the
// vector space stays consistent between a full build and incremental top-ups.

export const EMBED_MODEL = "Xenova/multilingual-e5-small";

/** e5 asymmetric-prefix scheme this build writes into the index (see lib/bookmark-search.ts). */
export const PREFIX_SCHEME = "e5";

/** The text fed to the embedder for a BookmarkPost (post-normalization). */
export function searchText(post) {
  return [
    post.text,
    post.articleTitle,
    post.articleText,
    post.author?.name,
    post.author?.screenName,
    ...(post.urls ?? []),
    post.quotedTweet?.text,
    post.quotedTweet?.author?.name,
    post.quotedTweet?.author?.screenName,
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

/** e5 "passage: " prefixed document text — what gets embedded for each indexed post. */
export function passageText(post) {
  return `passage: ${searchText(post)}`;
}

/** int8-quantize a normalized float embedding (matches the on-disk encoding). */
export function quantizeEmbedding(data) {
  return Array.from(data, (value) => Math.max(-127, Math.min(127, Math.round(value * 127))));
}
