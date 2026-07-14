import type { BookmarkPost } from "@/lib/bookmark-types";
import type { DigestSource } from "@/lib/digest-schema";

const TEXT_LIMIT = 280;
const EXCERPT_LIMIT = 500;

export function toDigestSource(post: BookmarkPost): DigestSource {
  const screenName = post.author?.screenName ?? "";
  const articleExcerpt = post.articleText ? truncateAtWord(post.articleText, EXCERPT_LIMIT) : undefined;
  return {
    id: post.id,
    author: post.author?.name ?? screenName,
    screenName,
    text: truncate(post.text || post.articleText || "", TEXT_LIMIT),
    articleTitle: post.articleTitle,
    ...(articleExcerpt ? { articleExcerpt } : {}),
    url: `https://x.com/${screenName || "i"}/status/${post.id}`,
  };
}

function truncate(s: string, n: number) {
  if (!s) return s;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// Same as truncate(), but cuts at the last word boundary within the limit
// rather than mid-word — used for article excerpts where a clean cut reads
// better in an LLM prompt.
function truncateAtWord(s: string, n: number) {
  if (!s || s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const boundary = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${boundary}…`;
}
