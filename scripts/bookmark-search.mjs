#!/usr/bin/env node
// Task 14 rebuild: this CLI used to carry its OWN third copy of the retrieval pipeline
// (stale MODEL constant pointing at the retired MiniLM model, un-grouped multiVectorSearch
// that double-counted v2 article-chunk items per bookmark, and `bookmarks.data ?? []`
// which silently returned zero posts against the current xrelay ArchiveFile shape —
// `{ tweets: [...] }`, not `{ data: [...] }` — see Task 1's report). It now reuses the same
// scripts/lib/search-core.mjs + scripts/lib/embed.mjs the eval harness and the app's Node
// mirror run, so this CLI produces the same ranking the app does (minus rerank, which is
// opt-in via --rerank since it downloads an extra ~23 MB model). CLI arg/output contract is
// unchanged — the user's global `bookmark-search` skill shells out to this file.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pipeline } from "@huggingface/transformers";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";
import { queryPrefix } from "./lib/embed.mjs";
import {
  applyRelativeFloor,
  buildKeywordIndex,
  buildRerankDocText,
  expandSemanticQueries,
  keywordSearch,
  multiVectorSearch,
  RERANK_WINDOW,
  rerankResults,
  runHybridPipeline,
} from "./lib/search-core.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const BOOKMARKS_PATH = join(root, "public/data/all-bookmarks.json");
const INDEX_PATH = join(root, "public/data/search-index.json");

const { values } = parseArgs({
  options: {
    query: { type: "string", short: "q" },
    limit: { type: "string", short: "n", default: "20" },
    filter: { type: "string", short: "f", default: "all" },
    sort: { type: "string", short: "s", default: "relevance" },
    format: { type: "string", default: "compact" },
    mode: { type: "string", default: "hybrid" },
    strict: { type: "boolean", default: false },
    broad: { type: "boolean", default: false },
    rerank: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || !values.query) {
  process.stdout.write(`bookmark-search — local hybrid (keyword + semantic) search over the X bookmark archive

Usage:
  node scripts/bookmark-search.mjs --query "<text>" [options]

Options:
  -q, --query    <text>           required; natural-language query
  -n, --limit    <n>              max results (default 20)
  -f, --filter   <kind>           all | article | media | photo | video | text  (default all)
  -s, --sort     <how>            relevance | newest | oldest | likes | bookmarks  (default relevance)
      --mode     <how>            hybrid | semantic | keyword  (default hybrid)
      --format   <kind>           compact | json  (default compact)
      --strict                    force strict precision (no query expansion, keyword-weighted, score floor)
      --broad                     force broad precision (disables the auto-strict heuristic for short queries)
      --rerank                    cross-encoder rerank the hybrid results (downloads an extra ~23 MB model)
  -h, --help

Precision defaults to auto: queries with 1–2 tokens use strict, longer queries use broad. Use --strict / --broad to override.

Output: JSON to stdout. Compact returns {id, score, author, text (truncated 240ch), url, createdAt, metrics}. json returns full BookmarkPost.
`);
  process.exit(values.query ? 0 : 1);
}

const limit = Math.max(1, Math.min(500, Number(values.limit) || 20));

const tokenCount = values.query.trim().split(/\s+/).filter(Boolean).length;
const precision = values.broad
  ? "broad"
  : values.strict || tokenCount <= 2
    ? "exact"
    : "broad";

const log = (...a) => console.error(...a);
log(`precision: ${precision}${values.strict || values.broad ? "" : ` (auto from ${tokenCount} token${tokenCount === 1 ? "" : "s"})`}`);

log("loading data…");
const [bookmarksPayload, index] = await Promise.all([
  readFile(BOOKMARKS_PATH, "utf8").then(JSON.parse),
  readFile(INDEX_PATH, "utf8").then(JSON.parse),
]);
// normalizeBookmarkPayload adapts BOTH the current xrelay ArchiveFile shape
// ({ tweets: [...] }) and the legacy { data: [...] } shape — `bookmarks.data ?? []` used to
// silently produce zero posts against today's archive (Task 1's report).
const posts = normalizeBookmarkPayload(bookmarksPayload);
const postById = new Map(posts.map((p) => [p.id, p]));

let semanticResults = [];
if (values.mode !== "keyword") {
  log(`loading model (${index.model})…`);
  const extractor = await pipeline("feature-extraction", index.model);
  const queries = expandSemanticQueries(values.query, precision);
  const prefix = queryPrefix(index);
  log(`embedding ${queries.length} query variant(s)…`);
  const embeddings = [];
  for (const q of queries) {
    const out = await extractor(`${prefix}${q}`, { pooling: "mean", normalize: true });
    embeddings.push(Array.from(out.data));
  }
  // search-core's multiVectorSearch max-pools per bookmark id across an item's main vector
  // AND any article-chunk vectors before ranking — the old local copy of this function
  // scored every item independently, so a v2 index (chunked articles) double- (or
  // n-)counted any bookmark with article-chunk vectors.
  semanticResults = multiVectorSearch(index, embeddings);
}

let keywordResults = [];
if (values.mode !== "semantic") {
  log("keyword index…");
  const lunrIndex = buildKeywordIndex(posts);
  keywordResults = keywordSearch(lunrIndex, values.query);
}

let ranked;
if (values.mode === "hybrid") {
  // Same pipeline the app runs: absolute vector floor (broad mode, e5 index only) ->
  // slice(0,900) -> RRF merge -> relative floor. See scripts/lib/search-core.mjs's
  // runHybridPipeline doc comment.
  ranked = runHybridPipeline(keywordResults, semanticResults, precision, index);
} else {
  // Debug-only modes (semantic-only / keyword-only): no RRF merge to run, so just apply the
  // same exact-precision relative floor the pre-Task-14 CLI applied uniformly regardless of
  // mode. Floors beyond that (the e5-only absolute vector floor, broad's relative floor) are
  // part of the hybrid hybrid pipeline and don't apply to a single-signal ranking.
  const single = values.mode === "semantic" ? semanticResults : keywordResults;
  ranked = precision === "exact" ? applyRelativeFloor(single, 0.5) : single;
}

if (values.rerank && ranked.length > 1) {
  log("reranking (cross-encoder)…");
  ranked = await rerankResults(
    values.query,
    ranked,
    (id) => buildRerankDocText(postById.get(id) ?? {}),
    RERANK_WINDOW,
  );
}

let filtered = ranked
  .map((r) => ({ ...r, post: postById.get(r.id) }))
  .filter((r) => r.post && matchesFilter(r.post, values.filter));

if (values.sort !== "relevance") {
  filtered = filtered.sort(comparator(values.sort));
}

const out = filtered.slice(0, limit).map(({ post, score }) =>
  values.format === "json"
    ? { score, ...post }
    : {
        id: post.id,
        score: Number(score.toFixed(4)),
        author: `${post.author?.name ?? ""} (@${post.author?.screenName ?? ""})`,
        text: truncate(post.text, 240),
        articleTitle: post.articleTitle,
        url: `https://x.com/${post.author?.screenName ?? "i"}/status/${post.id}`,
        createdAt: post.createdAtISO ?? post.createdAt,
        metrics: post.metrics,
        media: (post.media ?? []).map((m) => m.type).filter(Boolean),
      }
);

log(`returning ${out.length} of ${filtered.length} matches`);
process.stdout.write(JSON.stringify(out, null, 2) + "\n");

// ---- CLI-only helpers (not part of the shared pipeline — result display/filter/sort) ----

function matchesFilter(post, kind) {
  const media = post.media ?? [];
  switch (kind) {
    case "all": return true;
    case "article": return Boolean(post.articleTitle || post.articleText);
    case "media": return media.length > 0;
    case "photo": return media.some((m) => m.type === "photo");
    case "video": return media.some((m) => m.type === "video" || m.type === "animated_gif");
    case "text": return media.length === 0;
    default: return true;
  }
}

function comparator(sort) {
  const time = (p) => Date.parse(p.createdAtISO ?? p.createdAt ?? "") || 0;
  switch (sort) {
    case "newest": return (a, b) => time(b.post) - time(a.post);
    case "oldest": return (a, b) => time(a.post) - time(b.post);
    case "likes": return (a, b) => (b.post.metrics?.likes ?? 0) - (a.post.metrics?.likes ?? 0);
    case "bookmarks": return (a, b) => (b.post.metrics?.bookmarks ?? 0) - (a.post.metrics?.bookmarks ?? 0);
    default: return () => 0;
  }
}

function truncate(s, n) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
