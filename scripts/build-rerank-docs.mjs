// Precompute the per-doc rerank "passage" text for the server-side (Cloudflare Worker)
// search — Task 1. The Worker reranks with @cf/baai/bge-reranker-base over a hybrid window;
// each candidate needs the same doc text the browser cross-encoder used. buildRerankDocText
// below MIRRORS lib/rerank.ts's buildRerankDocText EXACTLY (authorship prefix + text +
// articleTitle + first ARTICLE_EXCERPT_CHARS of articleText + quoted text, whitespace-
// collapsed, capped at DOC_TEXT_CHAR_CAP). Output: public/data/rerank-docs.json as
// { [id]: docText } for every post.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";

// Mirrors of lib/rerank.ts constants.
const ARTICLE_EXCERPT_CHARS = 300;
const DOC_TEXT_CHAR_CAP = 1000;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "public/data/all-bookmarks.json");
const outputPath = join(root, "public/data/rerank-docs.json");

/** EXACT mirror of buildRerankDocText() in lib/rerank.ts. */
function buildRerankDocText(post) {
  const screenName = post.author?.screenName;
  const authorName = post.author?.name;
  const authorPrefix = screenName ? `@${screenName}${authorName ? ` (${authorName})` : ""}: ` : undefined;
  const parts = [
    authorPrefix,
    post.text,
    post.articleTitle,
    post.articleText ? post.articleText.slice(0, ARTICLE_EXCERPT_CHARS) : undefined,
    post.quotedTweet?.text,
  ].filter((part) => Boolean(part));
  const collapsed = parts.join(" ").replace(/\s+/g, " ").trim();
  return collapsed.slice(0, DOC_TEXT_CHAR_CAP);
}

const payload = JSON.parse(await readFile(sourcePath, "utf8"));
const posts = normalizeBookmarkPayload(payload);
const docs = {};
for (const post of posts) {
  docs[post.id] = buildRerankDocText(post);
}
await writeFile(outputPath, JSON.stringify(docs));
console.log(`Wrote ${outputPath} — rerank doc text for ${Object.keys(docs).length} posts.`);
