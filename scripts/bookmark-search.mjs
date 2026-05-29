#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import lunr from "lunr";
import { pipeline } from "@huggingface/transformers";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const BOOKMARKS_PATH = join(root, "public/data/all-bookmarks.json");
const INDEX_PATH = join(root, "public/data/search-index.json");
const MODEL = "Xenova/all-MiniLM-L6-v2";

const QUERY_EXPANSIONS = {
  ai: ["artificial intelligence", "llm", "large language model", "neural network", "machine learning", "model"],
  agent: ["agents", "agentic", "automation", "autonomous", "assistant", "workflow", "tool use"],
  agents: ["agent", "agentic", "automation", "autonomous", "assistants", "workflow", "tool use"],
  claude: ["claude code", "anthropic", "coding agent", "ai coding assistant"],
  codex: ["openai codex", "coding agent", "ai coding assistant", "code assistant"],
  code: ["coding", "programming", "developer", "software engineering", "repo", "repository"],
  context: ["memory", "knowledge", "prompt", "instructions", "prompt engineering", "rag"],
  learn: ["learning", "tutorial", "guide", "course", "education", "teach", "study", "explain"],
  memory: ["context", "knowledge graph", "persistence", "recall", "rag", "notes", "knowledge base"],
  prompt: ["prompts", "prompting", "prompt engineering", "instructions", "context", "system prompt"],
  prompts: ["prompt", "prompting", "prompt engineering", "instructions", "context", "system prompt"],
  search: ["retrieval", "semantic search", "vector search", "hybrid search", "rag", "index"],
  tool: ["tools", "cli", "mcp", "extension", "workflow", "automation"],
  tools: ["tool", "cli", "mcp", "extensions", "workflow", "automation"],
};

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
const [bookmarks, index] = await Promise.all([
  readFile(BOOKMARKS_PATH, "utf8").then(JSON.parse),
  readFile(INDEX_PATH, "utf8").then(JSON.parse),
]);
const posts = bookmarks.data ?? [];
const postById = new Map(posts.map((p) => [p.id, p]));

let semanticResults = [];
if (values.mode !== "keyword") {
  log("loading model…");
  const extractor = await pipeline("feature-extraction", MODEL);
  const queries = expandSemanticQueries(values.query, precision);
  log(`embedding ${queries.length} query variant(s)…`);
  const embeddings = [];
  for (const q of queries) {
    const out = await extractor(q, { pooling: "mean", normalize: true });
    embeddings.push(Array.from(out.data));
  }
  semanticResults = multiVectorSearch(index, embeddings);
}

let keywordResults = [];
if (values.mode !== "semantic") {
  log("keyword index…");
  const lunrIndex = buildKeywordIndex(posts);
  keywordResults = keywordSearch(lunrIndex, values.query);
}

let ranked;
if (values.mode === "semantic") ranked = semanticResults;
else if (values.mode === "keyword") ranked = keywordResults;
else ranked = mergeHybridResults(keywordResults, semanticResults, precision);

if (precision === "exact") ranked = applyRelativeFloor(ranked, 0.5);

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

// ---- helpers (parallel to lib/bookmark-search.ts) ----

function expandSemanticQueries(query, precision = "broad") {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (precision === "exact") return normalized ? [normalized] : [];
  const terms = lunr.tokenizer(normalized).map((t) => String(t)).filter(Boolean);
  const expansions = new Set([normalized]);
  const expandedTerms = terms.flatMap((t) => QUERY_EXPANSIONS[t] ?? []);
  if (expandedTerms.length) expansions.add(`${normalized} ${expandedTerms.join(" ")}`);
  for (const term of terms) {
    const syn = QUERY_EXPANSIONS[term];
    if (syn?.length) expansions.add(`${term} ${syn.join(" ")}`);
  }
  return [...expansions].filter(Boolean).slice(0, 8);
}

function buildKeywordIndex(posts) {
  return lunr(function () {
    this.ref("id");
    this.field("text", { boost: 4 });
    this.field("title", { boost: 5 });
    this.field("author", { boost: 2 });
    this.field("url");
    for (const p of posts) {
      this.add({
        id: p.id,
        text: p.text,
        title: p.articleTitle ?? "",
        author: `${p.author?.name ?? ""} ${p.author?.screenName ?? ""}`,
        url: (p.urls ?? []).join(" "),
      });
    }
  });
}

function keywordSearch(idx, query) {
  const terms = lunr.tokenizer(query).map((t) => String(t)).filter(Boolean);
  if (!terms.length) return [];
  try {
    return idx
      .query((b) => {
        b.term(terms, { boost: 2, presence: lunr.Query.presence.OPTIONAL, wildcard: lunr.Query.wildcard.TRAILING });
        b.term(terms, { boost: 1, editDistance: 1, presence: lunr.Query.presence.OPTIONAL });
      })
      .map((r) => ({ id: r.ref, score: r.score }));
  } catch {
    return idx.search(terms.map((t) => `${t}~1`).join(" ")).map((r) => ({ id: r.ref, score: r.score }));
  }
}

function multiVectorSearch(index, queryEmbeddings) {
  if (!queryEmbeddings.length) return [];
  return index.items
    .map((item) => {
      let best = -Infinity;
      let avg = 0;
      for (const e of queryEmbeddings) {
        const s = dot(e, item.embedding);
        if (s > best) best = s;
        avg += s;
      }
      return { id: item.id, score: best * 0.8 + (avg / queryEmbeddings.length) * 0.2 };
    })
    .sort((a, b) => b.score - a.score);
}

function mergeHybridResults(kw, vec, precision = "broad") {
  const [kwWeight, vecWeight] = precision === "exact" ? [0.6, 0.4] : [0.35, 0.65];
  const scores = new Map();
  const k = 60;
  for (const [i, r] of kw.entries()) scores.set(r.id, (scores.get(r.id) ?? 0) + kwWeight / (k + i + 1));
  for (const [i, r] of vec.entries()) scores.set(r.id, (scores.get(r.id) ?? 0) + vecWeight / (k + i + 1));
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

function applyRelativeFloor(results, fraction) {
  if (!results.length || fraction <= 0) return results;
  const top = results[0].score;
  if (top <= 0) return results;
  const floor = top * fraction;
  return results.filter((r) => r.score >= floor);
}

function dot(a, b) {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += (a[i] ?? 0) * (b[i] ?? 0);
  return t;
}

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
