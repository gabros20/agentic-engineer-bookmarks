// Serialize the lunr keyword index for the server-side (Cloudflare Worker) search — Task 1.
// The Worker will `lunr.Index.load(JSON.parse(...))` this instead of rebuilding lunr in the
// browser on every page load. The field/boost config and per-doc `add` shape below MIRROR
// lib/bookmark-search.ts's buildKeywordIndex EXACTLY (ref "id"; fields text/4, title/5,
// author/2, url, article/3, quoted/2; article body capped at ARTICLE_INDEX_CHAR_LIMIT). If
// buildKeywordIndex changes, update this in lockstep.
//
// Uses the repo-root lunr (2.3.9) — the serialized JSON embeds `"version":"2.3.9"`, and
// lunr.Index.load warns on a version mismatch, so the Worker (Task 2) must load with the
// same lunr major/minor.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import lunr from "lunr";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";

// Mirror of lib/bookmark-search.ts's ARTICLE_INDEX_CHAR_LIMIT.
const ARTICLE_INDEX_CHAR_LIMIT = 2000;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "public/data/all-bookmarks.json");
const outputPath = join(root, "public/data/lunr-index.json");

/** EXACT mirror of buildKeywordIndex() in lib/bookmark-search.ts. */
function buildKeywordIndex(posts) {
  return lunr(function build() {
    this.ref("id");
    this.field("text", { boost: 4 });
    this.field("title", { boost: 5 });
    this.field("author", { boost: 2 });
    this.field("url");
    this.field("article", { boost: 3 });
    this.field("quoted", { boost: 2 });

    for (const post of posts) {
      this.add({
        id: post.id,
        text: post.text,
        title: post.articleTitle ?? "",
        author: `${post.author.name} ${post.author.screenName}`,
        url: (post.urls ?? []).join(" "),
        article: (post.articleText ?? "").slice(0, ARTICLE_INDEX_CHAR_LIMIT),
        quoted: [post.quotedTweet?.text, post.quotedTweet?.author?.name, post.quotedTweet?.author?.screenName]
          .filter(Boolean)
          .join(" "),
      });
    }
  });
}

const payload = JSON.parse(await readFile(sourcePath, "utf8"));
const posts = normalizeBookmarkPayload(payload);
const index = buildKeywordIndex(posts);
await writeFile(outputPath, JSON.stringify(index.toJSON()));
console.log(`Wrote ${outputPath} — serialized lunr index over ${posts.length} posts.`);
