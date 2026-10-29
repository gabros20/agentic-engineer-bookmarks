// Precompute the per-doc rerank "passage" text for the server-side (Cloudflare Worker)
// search — Task 1. The Worker reranks with @cf/baai/bge-reranker-base over a hybrid window;
// each candidate needs the same doc text the browser cross-encoder used. The base text
// comes from scripts/lib/search-core.mjs's buildRerankDocText (Task 3, F2 drift fix) — the
// existing Node port of lib/rerank.ts's buildRerankDocText (already used by
// scripts/eval-search.mjs and asserted against the TS source by the drift guard in
// scripts/test-search-core.mjs) — IMPORTED here rather than hand-copied a second time, so
// there is exactly ONE .mjs copy of the authorship-prefix + parts + collapse + cap logic.
// One deliberate addition on top: a post-slice surrogate strip (see stripLoneSurrogates
// below) that lib/rerank.ts's browser copy doesn't need (local WASM tokenization tolerates
// lone surrogates) but the Worker's remote Workers AI call does not. Output:
// public/data/rerank-docs.json as { [id]: docText } for every post.

import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";
import { buildRerankDocText as buildRerankDocTextCore } from "./lib/search-core.mjs";

// A few posts carry unpaired UTF-16 surrogates in the source archive (malformed data — same
// class T1 hit in embed-bge.mjs). Workers AI hard-errors ("3030"/"3043") on any input with a
// lone surrogate, so the reranker batch dies deterministically whenever such a doc lands in a
// window. Strip only unpaired surrogates (valid emoji pairs preserved). Mirrors embed-bge.mjs.
function stripLoneSurrogates(text) {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "public/data/all-bookmarks.json");
const outputPath = join(root, "public/data/rerank-docs.json");

/**
 * Worker-specific wrapper: search-core.mjs's buildRerankDocText EXACTLY mirrors
 * lib/rerank.ts (authorship prefix + text + articleTitle + first ARTICLE_EXCERPT_CHARS of
 * articleText + quoted text, whitespace-collapsed, capped at DOC_TEXT_CHAR_CAP), then this
 * strips lone surrogates AFTER the cap: slicing at DOC_TEXT_CHAR_CAP can bisect a valid
 * emoji surrogate pair, creating a fresh lone surrogate at the boundary (this is why
 * stripping only the pre-slice text still left malformed docs).
 */
function buildRerankDocText(post) {
  return stripLoneSurrogates(buildRerankDocTextCore(post));
}

const payload = JSON.parse(await readFile(sourcePath, "utf8"));
const posts = normalizeBookmarkPayload(payload);
const docs = {};
for (const post of posts) {
  docs[post.id] = buildRerankDocText(post);
}
// Atomic (temp + rename): a killed sync never leaves a torn file behind.
await writeFile(`${outputPath}.tmp`, JSON.stringify(docs));
await rename(`${outputPath}.tmp`, outputPath);
console.log(`Wrote ${outputPath} — rerank doc text for ${Object.keys(docs).length} posts.`);
