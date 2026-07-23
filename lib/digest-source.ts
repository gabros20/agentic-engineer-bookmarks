import type { BookmarkPost } from "@/lib/bookmark-types";
import type { DigestSource } from "@/lib/digest-schema";

const TEXT_LIMIT = 280;
// T1 (digest engine upgrade): 500 -> 700. Richer synthesis (tldr + deeperReads need real
// article substance) at up to ~50 sources/request; kept modest rather than e.g. 1500+ to
// avoid materially bloating the prompt (worst case +200 chars * 50 sources = +10KB).
const EXCERPT_LIMIT = 700;

export function toDigestSource(post: BookmarkPost): DigestSource {
  const screenName = post.author?.screenName ?? "";
  const articleExcerpt = buildArticleExcerpt(post.articleText);
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

// Twin of stripMarkdownNoise() in scripts/lib/embed.mjs (kept as a separate copy —
// unifying across the lib/ vs scripts/ boundary is out of scope here). Same core rules
// (strip fenced/inline code and images, unwrap links to their visible text), plus
// heading hashes and blockquote markers stripped too: unlike embed.mjs's word-count/
// embedding use, this text is spliced verbatim into an LLM prompt line, where a leading
// "#" or ">" reads as stray markdown noise rather than content.
function stripMarkdownNoise(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> visible text
    .replace(/^#{1,6}\s+/gm, "") // heading hashes
    .replace(/^>\s?/gm, ""); // blockquote markers
}

// Builds the LLM-facing article excerpt: strip markdown noise, collapse all whitespace
// runs (including embedded paragraph breaks) to single spaces, then truncate at a word
// boundary. Returns undefined (not "") for empty/whitespace-only/markdown-only input, so
// callers can honor the "articleExcerpt is ABSENT, not empty" contract.
function buildArticleExcerpt(articleText: string | undefined): string | undefined {
  if (!articleText) return undefined;
  const collapsed = stripMarkdownNoise(articleText).replace(/\s+/g, " ").trim();
  return collapsed ? truncateAtWord(collapsed, EXCERPT_LIMIT) : undefined;
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
