// GATE eval harness for the Cloudflare bge-m3 + bge-reranker Worker pipeline (Task 3).
//
// This is the cutover GATE: it measures the REAL Worker pipeline (not a node
// approximation) over the golden queries and compares the scorecard against the recorded
// e5 baseline (scripts/eval-baseline.json). For every golden query it POSTs to the running
// Worker's POST /search and scores the returned ranked ids against the golden relevant ids,
// computing Recall@10 / MRR@10 / nDCG@10 per query class + overall, plus broad-mode result
// counts ("broad tail"). Prints the scorecard, prints the bge-vs-e5 comparison table with a
// PASS/FAIL verdict, and writes scripts/eval-baseline-bge.json (NEVER overwrites the e5
// eval-baseline.json).
//
// DRIVE THE WORKER (from worker/, Workers AI runs remotely — auth required):
//   cd public && python3 -m http.server 8080            # dev data server (DATA_BASE_URL)
//   cd worker && npx wrangler dev --port 8787           # the Worker
//   node scripts/eval-bge.mjs                            # this harness (WORKER_URL overridable)
//
// GATE (task-3-brief): bge overall recall@10/mrr@10/ndcg@10 must be >= the e5 baseline, AND
// no single class may fall materially (> CLASS_REGRESSION_TOLERANCE abs) below its e5 value.
//
// HONESTY NOTE (mirrors scripts/eval-search.mjs): this harness sends NO LLM query rewrites
// (the `rewrites` field is omitted), so — exactly like the e5 baseline harness — every
// hu-topic query is reranked against its RAW Hungarian text, not a live English rewrite. So
// hu-topic numbers on BOTH sides of this comparison are a lower bound on shipping quality;
// the comparison stays apples-to-apples because neither side gets rewrites.

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const QUERIES_PATH = join(root, "scripts/eval-queries.json");
const META_PATH = join(root, "public/data/search-index-bge.meta.json");
const E5_BASELINE_PATH = join(root, "scripts/eval-baseline.json");
const BGE_BASELINE_PATH = join(root, "scripts/eval-baseline-bge.json");

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";

// T4: /search is now gated by the X-Proxy-Secret shared secret (the same one the Vercel proxy
// forwards). The eval hits the Worker DIRECTLY (bypassing the Vercel proxy/auth/quota, which are
// orthogonal to ranking), so it must send the secret itself or every query 401s. Read it from
// SEARCH_PROXY_SECRET, else fall back to parsing worker/.dev.vars (where local `wrangler dev`
// gets it). Sending the correct secret runs the identical ranking path → output is unchanged.
function loadProxySecret() {
  if (process.env.SEARCH_PROXY_SECRET) return process.env.SEARCH_PROXY_SECRET;
  try {
    const devVars = readFileSync(join(root, "worker/.dev.vars"), "utf8");
    const match = devVars.match(/^\s*SEARCH_PROXY_SECRET\s*=\s*(.+)\s*$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    /* fall through to the explicit error below */
  }
  return null;
}
const PROXY_SECRET = loadProxySecret();
if (!PROXY_SECRET) {
  console.error(
    "FATAL: SEARCH_PROXY_SECRET not found (env var or worker/.dev.vars). The Worker's /search is\n" +
      "gated (T4); set SEARCH_PROXY_SECRET or add it to worker/.dev.vars so the eval can authenticate.",
  );
  process.exit(1);
}
const TOP_K = 10;
// Ask the Worker for the FULL floored result set (its default cap is 240) so the broad-tail
// count reflects the true post-floor size, matching eval-search.mjs's uncapped methodology.
const RESULT_LIMIT = 100000;
const CLASS_REGRESSION_TOLERANCE = 0.1; // "materially below" threshold from the brief.

const VALID_PRECISIONS = new Set(["exact", "broad"]);
const VALID_CLASSES = new Set(["en-topic", "hu-topic", "handle", "article-title", "phrase", "paraphrase"]);

console.log("loading golden queries + bge index meta…");
const [goldenQueries, meta, e5Baseline] = await Promise.all([
  readFile(QUERIES_PATH, "utf8").then(JSON.parse),
  readFile(META_PATH, "utf8").then(JSON.parse),
  readFile(E5_BASELINE_PATH, "utf8").then(JSON.parse),
]);

// ---- validate golden queries against the bge index (fail loudly, same as eval-search.mjs) ----
const indexIds = new Set(meta.items.map((m) => m.id));
const problems = [];
for (const q of goldenQueries) {
  if (!Array.isArray(q.relevant) || q.relevant.length < 1 || q.relevant.length > 5) {
    problems.push(`"${q.query}": relevant[] length out of 1-5 range`);
  }
  if (!VALID_PRECISIONS.has(q.precision)) problems.push(`"${q.query}": invalid precision ${JSON.stringify(q.precision)}`);
  if (!VALID_CLASSES.has(q.class)) problems.push(`"${q.query}": unknown class ${JSON.stringify(q.class)}`);
  for (const r of q.relevant ?? []) {
    if (!indexIds.has(r.id)) problems.push(`"${q.query}": relevant id ${r.id} not in bge index`);
  }
}
if (problems.length) {
  console.error(`FATAL: ${problems.length} golden-query problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

console.log(`worker: ${WORKER_URL}`);
console.log(`bge index: count=${meta.count} vectors=${meta.vector_count} model=${meta.model}`);

// ---- drive the real Worker /search ----
async function searchWorker(query, precision) {
  const res = await fetch(`${WORKER_URL}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Proxy-Secret": PROXY_SECRET },
    // NO `rewrites` (see honesty note above): raw-query rerank on both sides.
    body: JSON.stringify({ query, precision, limit: RESULT_LIMIT }),
  });
  if (!res.ok) throw new Error(`/search ${res.status} for ${JSON.stringify({ query, precision })}: ${await res.text()}`);
  const body = await res.json();
  if (!Array.isArray(body.results)) throw new Error(`/search returned no results[] for "${query}"`);
  return body.results;
}

// ---- metrics: binary relevance, Recall@10 / MRR@10 / nDCG@10 (identical to eval-search.mjs) ----
function recallAt10(ranked, relevantIds) {
  const top = new Set(ranked.slice(0, TOP_K).map((r) => r.id));
  let hits = 0;
  for (const id of relevantIds) if (top.has(id)) hits += 1;
  return hits / relevantIds.length;
}
function mrrAt10(ranked, relevantSet) {
  for (const [i, r] of ranked.slice(0, TOP_K).entries()) if (relevantSet.has(r.id)) return 1 / (i + 1);
  return 0;
}
function ndcgAt10(ranked, relevantSet) {
  let dcg = 0;
  for (const [i, r] of ranked.slice(0, TOP_K).entries()) if (relevantSet.has(r.id)) dcg += 1 / Math.log2(i + 2);
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

// ---- evaluate (serial: deterministic + gentle on the Worker's per-request rerank) ----
const perQuery = [];
const broadResultCounts = [];
console.log(`evaluating ${goldenQueries.length} golden queries via the Worker…`);
for (const [i, q] of goldenQueries.entries()) {
  const ranked = await searchWorker(q.query, q.precision);
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
  console.log(`[${i + 1}/${goldenQueries.length}] (${q.class}/${q.precision}) "${q.query.slice(0, 48)}" -> n=${ranked.length}`);
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
const sortedBroad = [...broadResultCounts].sort((a, b) => a - b);
const broadTail = {
  n: broadResultCounts.length,
  medianResultCount: percentile(sortedBroad, 50),
  p90ResultCount: percentile(sortedBroad, 90),
};

// ---- print scorecard ----
console.log("\n=== Scorecard: bge-m3 + bge-reranker (real Worker pipeline) ===");
console.log(`model: ${meta.model}\n`);
const header = ["class", "n", "recall@10", "mrr@10", "ndcg@10"];
const scoreRows = [
  ...classes.map((c) => [c, byClass[c].n, byClass[c].recall10, byClass[c].mrr10, byClass[c].ndcg10]),
  ["OVERALL", overall.n, overall.recall10, overall.mrr10, overall.ndcg10],
];
const w = header.map((h, i) => Math.max(h.length, ...scoreRows.map((r) => String(r[i]).length)));
const fmt = (r) => r.map((c, i) => String(c).padEnd(w[i])).join("  ");
console.log(fmt(header));
console.log(w.map((n) => "-".repeat(n)).join("  "));
for (const r of scoreRows) console.log(fmt(r));
console.log(`\nbroad-tail (n=${broadTail.n}): median=${broadTail.medianResultCount} p90=${broadTail.p90ResultCount}`);

// ---- GATE comparison vs e5 baseline ----
console.log("\n=== GATE: bge vs e5 baseline (Δ = bge − e5) ===");
const cmpHeader = ["class", "recall@10 (bge/e5/Δ)", "mrr@10 (bge/e5/Δ)", "ndcg@10 (bge/e5/Δ)"];
function triple(bge, e5) {
  const d = bge - e5;
  const sign = d >= 0 ? "+" : "";
  return `${bge.toFixed(4)}/${e5.toFixed(4)}/${sign}${d.toFixed(4)}`;
}
const cmpRows = [];
const regressions = [];
for (const cls of classes) {
  const b = byClass[cls];
  const e = e5Baseline.by_class[cls];
  if (!e) {
    cmpRows.push([cls, `${b.recall10} (no e5 class)`, "", ""]);
    continue;
  }
  cmpRows.push([cls, triple(b.recall10, e.recall10), triple(b.mrr10, e.mrr10), triple(b.ndcg10, e.ndcg10)]);
  // "materially below" tracked on recall@10 (the primary retrieval metric) per class.
  if (b.recall10 < e.recall10 - CLASS_REGRESSION_TOLERANCE) {
    regressions.push(`${cls}: recall@10 ${b.recall10} vs e5 ${e.recall10} (Δ ${(b.recall10 - e.recall10).toFixed(4)}, > ${CLASS_REGRESSION_TOLERANCE} drop)`);
  }
}
cmpRows.push([
  "OVERALL",
  triple(overall.recall10, e5Baseline.overall.recall10),
  triple(overall.mrr10, e5Baseline.overall.mrr10),
  triple(overall.ndcg10, e5Baseline.overall.ndcg10),
]);
const cw = cmpHeader.map((h, i) => Math.max(h.length, ...cmpRows.map((r) => String(r[i]).length)));
const cfmt = (r) => r.map((c, i) => String(c).padEnd(cw[i])).join("  ");
console.log(cfmt(cmpHeader));
console.log(cw.map((n) => "-".repeat(n)).join("  "));
for (const r of cmpRows) console.log(cfmt(r));

const overallPass =
  overall.recall10 >= e5Baseline.overall.recall10 &&
  overall.mrr10 >= e5Baseline.overall.mrr10 &&
  overall.ndcg10 >= e5Baseline.overall.ndcg10;
const gatePass = overallPass && regressions.length === 0;

console.log("\n=== VERDICT ===");
console.log(`overall meets/beats e5 on all three metrics: ${overallPass ? "YES" : "NO"}`);
console.log(`no class materially (> ${CLASS_REGRESSION_TOLERANCE}) below its e5 recall@10: ${regressions.length === 0 ? "YES" : "NO"}`);
if (regressions.length) for (const r of regressions) console.log(`  REGRESSION: ${r}`);
console.log(`GATE: ${gatePass ? "PASS ✅" : "FAIL ❌"}`);

// ---- write bge baseline (own file — never overwrite e5 eval-baseline.json) ----
const baseline = {
  generated_at: new Date().toISOString(),
  model: meta.model,
  rerank_model: "@cf/baai/bge-reranker-base",
  worker_url: WORKER_URL,
  index_count: meta.count,
  vector_count: meta.vector_count,
  query_count: goldenQueries.length,
  gate: {
    passed: gatePass,
    overall_meets_e5: overallPass,
    class_regressions: regressions,
    compared_to: "scripts/eval-baseline.json",
    e5_overall: e5Baseline.overall,
  },
  overall,
  by_class: byClass,
  broad_tail: broadTail,
  per_query: perQuery,
};
await writeFile(BGE_BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
console.log(`\nwrote ${BGE_BASELINE_PATH}`);
process.exit(gatePass ? 0 : 2);
