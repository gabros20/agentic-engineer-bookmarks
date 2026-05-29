import type { BookmarkPost } from "@/lib/bookmark-types";
import type { DigestSource } from "@/lib/digest-schema";

const TEXT_LIMIT = 280;

export function toDigestSource(post: BookmarkPost): DigestSource {
  const screenName = post.author?.screenName ?? "";
  return {
    id: post.id,
    author: post.author?.name ?? screenName,
    screenName,
    text: truncate(post.text ?? post.articleText ?? "", TEXT_LIMIT),
    articleTitle: post.articleTitle,
    url: `https://x.com/${screenName || "i"}/status/${post.id}`,
  };
}

function truncate(s: string, n: number) {
  if (!s) return s;
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
