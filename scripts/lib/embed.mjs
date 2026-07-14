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

// ── index schema v2: chunked article vectors ──────────────────────────────

const CHUNK_TARGET_WORDS = 280;
const CHUNK_HARD_CAP_WORDS = 350;
// A chunk this small (or smaller), wherever it lands, reads as an orphan sentence, not a
// standalone unit of meaning — fold it into a neighboring chunk instead of shipping a
// near-empty vector.
const CHUNK_MIN_WORDS = 40;

/** Strip markdown syntax noise before word-counting/embedding: code fences and images removed, links reduced to their visible text. */
function stripMarkdownNoise(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // links -> their visible text
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Merge any chunk below CHUNK_MIN_WORDS into a neighbor instead of shipping it as its
 * own near-empty vector: fold into the previous chunk, or into the next chunk if the
 * tiny one is first (no previous to fold into). Runs left-to-right and re-checks the
 * merged-into slot so consecutive tiny chunks (e.g. two short paragraphs in a row) don't
 * slip through.
 */
function mergeTinyChunks(chunks) {
  const merged = [...chunks];
  let i = 0;
  while (i < merged.length && merged.length > 1) {
    if (wordCount(merged[i]) >= CHUNK_MIN_WORDS) {
      i += 1;
      continue;
    }
    if (i === 0) {
      merged[0] = `${merged[0]} ${merged[1]}`;
      merged.splice(1, 1);
      // Re-check index 0: the newly merged chunk could itself still be tiny if the
      // chunk it absorbed was also below the minimum.
    } else {
      merged[i - 1] = `${merged[i - 1]} ${merged[i]}`;
      merged.splice(i, 1);
      // Don't advance i: the element that shifted into this slot still needs checking.
    }
  }
  return merged;
}

/**
 * Split article markdown into ~280-word chunks on paragraph boundaries (hard cap ~350
 * words per chunk; any chunk below CHUNK_MIN_WORDS — wherever it lands — merges into a
 * neighbor instead of shipping as its own near-empty vector). Each chunk is prefixed
 * with the article title so it stays anchored to its subject once separated from the
 * rest of the article. Returns [] for empty/whitespace-only markdown.
 */
export function chunkArticle(markdown, title) {
  if (!markdown || !markdown.trim()) return [];

  const paragraphs = stripMarkdownNoise(markdown)
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!paragraphs.length) return [];

  let chunks = [];
  let bufferParas = [];
  let bufferWords = 0;

  for (const para of paragraphs) {
    const paraWords = wordCount(para);
    // Closing early (before adding) keeps any single over-cap paragraph as its
    // own chunk rather than splitting mid-paragraph, which the brief doesn't ask for.
    if (bufferWords > 0 && bufferWords + paraWords > CHUNK_HARD_CAP_WORDS) {
      chunks.push(bufferParas.join(" "));
      bufferParas = [];
      bufferWords = 0;
    }
    bufferParas.push(para);
    bufferWords += paraWords;
    if (bufferWords >= CHUNK_TARGET_WORDS) {
      chunks.push(bufferParas.join(" "));
      bufferParas = [];
      bufferWords = 0;
    }
  }
  if (bufferParas.length) chunks.push(bufferParas.join(" "));

  chunks = mergeTinyChunks(chunks);

  const prefix = title ? `${title}: ` : "";
  return chunks.map((chunk) => `${prefix}${chunk}`);
}

/**
 * Items to embed for a post (index schema v2): always one main entry — v1-compatible
 * shape, no `part` key — plus one `{ part, text }` entry per article chunk when the post
 * has non-empty `articleText`. `part` starts at 1 and follows chunk order.
 */
export function embedItemsForPost(post) {
  // Same empty-searchText fallback Task 3 established for the main vector (avoids
  // collapsing every text-less post onto the identical "passage: " embedding).
  const mainText = searchText(post) ? passageText(post) : `passage: ${post.id}`;
  const items = [{ text: mainText }];

  if (post.articleText && post.articleText.trim()) {
    const chunks = chunkArticle(post.articleText, post.articleTitle);
    chunks.forEach((chunk, i) => {
      items.push({ part: i + 1, text: `passage: ${chunk}` });
    });
  }

  return items;
}
