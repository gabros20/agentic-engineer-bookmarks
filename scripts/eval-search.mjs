// Golden-query eval harness for the hybrid (keyword + semantic) search pipeline.
//
// Runs the exact retrieval pipeline from scripts/lib/search-core.mjs (a Node port of
// lib/bookmark-search.ts) over the real archive + search index, against a fixed set of
// golden queries (scripts/eval-queries.json), and reports Recall@10 / MRR@10 / nDCG@10
// per query class and overall, plus broad-mode post-merge result-count stats ("broad
// tail"). Prints a scorecard to stdout and writes it to scripts/eval-baseline.json.
//
// This is the measurement harness for the search-relevance upgrade: later changes
// (embedding model swap, chunked article vectors, score floors) are gated on this
// scorecard not regressing vs. the recorded baseline.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";
import {
  applyAbsoluteVectorFloor,
  applyRelativeFloor,
  BROAD_MERGED_RELATIVE_FLOOR,
  BROAD_VECTOR_COSINE_FLOOR,
  buildKeywordIndex,
  expandSemanticQueries,
  keywordSearch,
  mergeHybridResults,
  multiVectorSearch,
} from "./lib/search-core.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const BOOKMARKS_PATH = join(root, "public/data/all-bookmarks.json");
const INDEX_PATH = join(root, "public/data/search-index.json");
const QUERIES_PATH = join(root, "scripts/eval-queries.json");
const BASELINE_PATH = join(root, "scripts/eval-baseline.json");

const TOP_K = 10;
const VECTOR_SLICE = 900; // matches components/bookmarks-app.tsx:256
const EXACT_FLOOR = 0.5; // matches components/bookmarks-app.tsx:258

console.log("loading data…");
const [bookmarksPayload, index, goldenQueries] = await Promise.all([
  readFile(BOOKMARKS_PATH, "utf8").then(JSON.parse),
  readFile(INDEX_PATH, "utf8").then(JSON.parse),
  readFile(QUERIES_PATH, "utf8").then(JSON.parse),
]);

const posts = normalizeBookmarkPayload(bookmarksPayload);
const postIds = new Set(posts.map((p) => p.id));

const VALID_PRECISIONS = new Set(["exact", "broad"]);
const VALID_CLASSES = new Set(["en-topic", "hu-topic", "handle", "article-title", "phrase", "paraphrase"]);

// Fail loudly on any golden query with malformed shape: unknown relevant ids, a
// missing/out-of-range relevant array, an invalid precision, or an unknown class.
const unknownIds = [];
const badRelevantCount = [];
const badPrecision = [];
const badClass = [];
for (const q of goldenQueries) {
  for (const r of q.relevant) {
    if (!postIds.has(r.id)) unknownIds.push({ query: q.query, id: r.id });
  }
  if (!Array.isArray(q.relevant) || q.relevant.length < 1 || q.relevant.length > 5) {
    badRelevantCount.push({ query: q.query, count: Array.isArray(q.relevant) ? q.relevant.length : typeof q.relevant });
  }
  if (!VALID_PRECISIONS.has(q.precision)) {
    badPrecision.push({ query: q.query, precision: q.precision });
  }
  if (!VALID_CLASSES.has(q.class)) {
    badClass.push({ query: q.query, class: q.class });
  }
}
if (unknownIds.length) {
  console.error(`FATAL: ${unknownIds.length} golden relevant id(s) not found in ${BOOKMARKS_PATH}:`);
  for (const u of unknownIds) console.error(`  query="${u.query}" id=${u.id}`);
  process.exit(1);
}
if (badRelevantCount.length) {
  console.error(`FATAL: ${badRelevantCount.length} golden quer(y/ies) with relevant[] not in the required 1-5 range:`);
  for (const b of badRelevantCount) console.error(`  query="${b.query}" relevant.length=${b.count}`);
  process.exit(1);
}
if (badPrecision.length) {
  console.error(
    `FATAL: ${badPrecision.length} golden quer(y/ies) with invalid precision (must be "exact" or "broad"):`,
  );
  for (const b of badPrecision) console.error(`  query="${b.query}" precision=${JSON.stringify(b.precision)}`);
  process.exit(1);
}
if (badClass.length) {
  console.error(
    `FATAL: ${badClass.length} golden quer(y/ies) with unknown class (must be one of ${[...VALID_CLASSES].join(", ")}):`,
  );
  for (const b of badClass) console.error(`  query="${b.query}" class=${JSON.stringify(b.class)}`);
  process.exit(1);
}

console.log(`archive: ${posts.length} posts; index: ${index.count} embeddings (model=${index.model})`);
console.log("building keyword index…");
const keywordIndex = buildKeywordIndex(posts);

console.log(`loading embedding model (${index.model})…`);
const extractor = await pipeline("feature-extraction", index.model);
const prefix = index.prefix_scheme === "e5" ? "query: " : "";

async function embedQueries(queries) {
  const embeddings = [];
  for (const q of queries) {
    const output = await extractor(`${prefix}${q}`, { pooling: "mean", normalize: true });
    embeddings.push(Array.from(output.data));
  }
  return embeddings;
}

// ---- run the pipeline per golden query, exactly as components/bookmarks-app.tsx does ----

// Broad-mode relevance floors (T1.3): only active against the v2 e5 index — see
// BROAD_VECTOR_COSINE_FLOOR / BROAD_MERGED_RELATIVE_FLOOR in scripts/lib/search-core.mjs.
// Pipeline order for broad mode: pooled vector results -> absolute floor -> slice(0,900)
// -> RRF merge -> relative floor. Exact mode is untouched (keeps its 0.5 relative floor).
const FLOORS_ACTIVE = index.prefix_scheme === "e5";

async function runQuery(query, precision) {
  const keywordResults = keywordSearch(keywordIndex, query);
  const expandedQueries = expandSemanticQueries(query, precision);
  const embeddings = await embedQueries(expandedQueries);
  const pooledVectorResults = multiVectorSearch(index, embeddings);
  const vectorResults = (
    precision === "broad" && FLOORS_ACTIVE
      ? applyAbsoluteVectorFloor(pooledVectorResults, BROAD_VECTOR_COSINE_FLOOR)
      : pooledVectorResults
  ).slice(0, VECTOR_SLICE);
  const merged = mergeHybridResults(keywordResults, vectorResults, precision);
  if (precision === "exact") return applyRelativeFloor(merged, EXACT_FLOOR);
  return FLOORS_ACTIVE ? applyRelativeFloor(merged, BROAD_MERGED_RELATIVE_FLOOR) : merged;
}

// ---- metrics: binary relevance, Recall@10 / MRR@10 / nDCG@10 ----

function recallAt10(ranked, relevantIds) {
  const top = new Set(ranked.slice(0, TOP_K).map((r) => r.id));
  let hits = 0;
  for (const id of relevantIds) if (top.has(id)) hits += 1;
  return hits / relevantIds.length;
}

function mrrAt10(ranked, relevantSet) {
  for (const [i, r] of ranked.slice(0, TOP_K).entries()) {
    if (relevantSet.has(r.id)) return 1 / (i + 1);
  }
  return 0;
}

function ndcgAt10(ranked, relevantSet) {
  let dcg = 0;
  for (const [i, r] of ranked.slice(0, TOP_K).entries()) {
    if (relevantSet.has(r.id)) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(relevantSet.size, TOP_K);
  let idcg = 0;
  for (let i = 0; i < idealHits; i += 1) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

// ---- evaluate ----

const perQuery = [];
const broadResultCounts = [];

console.log(`evaluating ${goldenQueries.length} golden queries…`);
for (const [i, q] of goldenQueries.entries()) {
  const ranked = await runQuery(q.query, q.precision);
  const relevantIds = q.relevant.map((r) => r.id);
  const relevantSet = new Set(relevantIds);

  if (q.precision === "broad") broadResultCounts.push(ranked.length);

  perQuery.push({
    query: q.query,
    class: q.class,
    precision: q.precision,
    recall10: recallAt10(ranked, relevantIds),
    mrr10: mrrAt10(ranked, relevantSet),
    ndcg10: ndcgAt10(ranked, relevantSet),
    resultCount: ranked.length,
  });

  console.log(`[${i + 1}/${goldenQueries.length}] (${q.class}/${q.precision}) "${q.query}"`);
}

// ---- aggregate per class + overall ----

function aggregate(rows) {
  return {
    n: rows.length,
    recall10: Number(mean(rows.map((r) => r.recall10)).toFixed(4)),
    mrr10: Number(mean(rows.map((r) => r.mrr10)).toFixed(4)),
    ndcg10: Number(mean(rows.map((r) => r.ndcg10)).toFixed(4)),
  };
}

const classes = [...new Set(perQuery.map((r) => r.class))].sort();
const byClass = {};
for (const cls of classes) byClass[cls] = aggregate(perQuery.filter((r) => r.class === cls));
const overall = aggregate(perQuery);

const sortedBroadCounts = [...broadResultCounts].sort((a, b) => a - b);
const broadTail = {
  n: broadResultCounts.length,
  medianResultCount: percentile(sortedBroadCounts, 50),
  p90ResultCount: percentile(sortedBroadCounts, 90),
};

// ---- print scorecard ----

console.log("\n=== Scorecard: baseline (current stack) ===");
console.log(`model: ${index.model}\n`);
const header = ["class", "n", "recall@10", "mrr@10", "ndcg@10"];
const rows = [
  ...classes.map((cls) => [cls, byClass[cls].n, byClass[cls].recall10, byClass[cls].mrr10, byClass[cls].ndcg10]),
  ["OVERALL", overall.n, overall.recall10, overall.mrr10, overall.ndcg10],
];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const fmtRow = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join("  ");
console.log(fmtRow(header));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const r of rows) console.log(fmtRow(r));

console.log(
  `\nbroad-tail (post-merge result count, n=${broadTail.n}): median=${broadTail.medianResultCount} p90=${broadTail.p90ResultCount}`,
);

// ---- write baseline json ----

const baseline = {
  generated_at: new Date().toISOString(),
  model: index.model,
  index_count: index.count,
  archive_count: posts.length,
  query_count: goldenQueries.length,
  overall,
  by_class: byClass,
  broad_tail: broadTail,
  per_query: perQuery,
};

await writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
console.log(`\nwrote ${BASELINE_PATH}`);
