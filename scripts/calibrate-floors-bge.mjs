// Broad-mode floor sweep for the bge-m3 Worker pipeline (Task 3 Part B).
//
// The e5 sweep (scripts/calibrate-floors.mjs) can't be reused as-is: it asserts
// prefix_scheme === "e5", and e5's cosine distribution (floor 0.82) is invalid for bge-m3
// (cosines top ~0.67 per the T0 spike / T2). This script recalibrates the bge broad-mode
// floors against the SAME golden queries, replicating the Worker's FULL HYBRID pipeline
// (keyword ⊕ vector, matching worker/src/index.ts after T3b) in Node:
//
//   1. embed each golden query's expandSemanticQueries variants via the Worker's gated
//      /embed route (raw bge-m3 vectors — the exact vectors /search uses),
//   1b. keywordSearch(lunr index, raw query) -> keyword hits (same lunr-index.json + query
//       the Worker uses; identical on both sides of the gate),
//   2. multiVectorSearch(bge index, vectors) -> pooled per-id scores (UNSLICED),
//   3. for each grid cell replay the broad pipeline: applyAbsoluteVectorFloor -> slice(0,900)
//      -> mergeHybridResults(keyword, v, "broad") -> applyRelativeFloor(.., BROAD_FLOOR_MIN_KEEP)
//      exactly as lib runHybridPipeline wires it,
//   4. measure per broad query: broad-tail COUNT, window-recall (relevant present in the
//      top-RERANK_WINDOW that the reranker actually sees — the true "no recall loss" guard,
//      since the reranker decides final top-10 only from that window), and pre-rerank
//      recall@10.
//
// Selection: among cells that preserve BOTH window-recall AND pre-rerank recall@10 on EVERY
// broad class (vs the no-floor cell), pick the smallest broad-tail median; tie-break larger
// absolute floor then larger relative floor (mirrors calibrate-floors.mjs). The chosen cell
// is validated end-to-end (post-rerank) by re-running scripts/eval-bge.mjs after wiring.
//
// DRIVE (from repo root, with the Worker + data server up, /embed secret set):
//   cd public && python3 -m http.server 8080
//   cd worker && npx wrangler dev --port 8787
//   EMBED_SECRET=... node scripts/calibrate-floors-bge.mjs
//
// Writes .orchestrate/raw/task3-bge-sweep.json (regenerable, not committed).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import lunr from "lunr";
import {
  applyAbsoluteVectorFloor,
  applyRelativeFloor,
  BROAD_FLOOR_MIN_KEEP,
  expandSemanticQueries,
  keywordSearch,
  mergeHybridResults,
  multiVectorSearch,
} from "./lib/search-core.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const INDEX_PATH = join(root, "public/data/search-index-bge.json");
const LUNR_INDEX_PATH = join(root, "public/data/lunr-index.json");
const QUERIES_PATH = join(root, "scripts/eval-queries.json");
const SWEEP_OUT_PATH = join(root, ".orchestrate/raw/task3-bge-sweep.json");

const WORKER_URL = process.env.WORKER_URL ?? "http://localhost:8787";
const EMBED_SECRET = process.env.EMBED_SECRET ?? "dev-embed-secret-local-only";

const TOP_K = 10;
const RERANK_WINDOW = 50; // matches lib/rerank-core RERANK_WINDOW / the Worker's window.
const VECTOR_SLICE = 900; // matches lib runHybridPipeline.

// bge cosines top ~0.67 (spike/T2), so the e5 0.70-0.90 grid is wrong. Absolute grid:
// none, 0.30..0.66 step 0.02 (applied to POOLED per-id scores on the 127*cosine int8 scale).
const ABS_FLOOR_GRID = [null];
for (let f = 0.3; f <= 0.6601; f += 0.02) ABS_FLOOR_GRID.push(Number(f.toFixed(2)));
// Relative grid: none, 0.10..0.50 step 0.05 (applied to merged RRF scores).
const REL_FLOOR_GRID = [null, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];

console.log("loading bge index + lunr index + golden queries…");
const [index, lunrJson, goldenQueries] = await Promise.all([
  readFile(INDEX_PATH, "utf8").then(JSON.parse),
  readFile(LUNR_INDEX_PATH, "utf8").then(JSON.parse),
  readFile(QUERIES_PATH, "utf8").then(JSON.parse),
]);
if (index.model !== "@cf/baai/bge-m3") {
  console.error(`FATAL: ${INDEX_PATH} model=${JSON.stringify(index.model)}, expected "@cf/baai/bge-m3".`);
  process.exit(1);
}
// Same serialized lunr index the Worker loads (T1 build-lunr-index.mjs). keywordSearch over
// this is identical on both sides of the gate; here it feeds the hybrid merge in each cell.
const keywordIndex = lunr.Index.load(lunrJson);
console.log(`index: ${index.count} bookmarks, ${index.items.length} vectors (model=${index.model})`);
console.log(`worker /embed: ${WORKER_URL}/embed`);

// ---- embed a batch of query strings via the Worker's gated /embed ----
async function embedTexts(texts) {
  const res = await fetch(`${WORKER_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Embed-Secret": EMBED_SECRET },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) throw new Error(`/embed ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!Array.isArray(body.vectors)) throw new Error("/embed returned no vectors[]");
  return body.vectors;
}

// ---- precompute pooled (unsliced) vector results per broad golden query ----
console.log("precomputing pooled vectors per broad query (via /embed)…");
const precomputed = [];
for (const [i, q] of goldenQueries.entries()) {
  if (q.precision !== "broad") continue; // floors only touch broad mode.
  const expandedQueries = expandSemanticQueries(q.query, q.precision);
  const embeddings = await embedTexts(expandedQueries);
  const pooledVectorResults = multiVectorSearch(index, embeddings); // pooled per-id, UNSLICED
  const keywordResults = keywordSearch(keywordIndex, q.query); // raw query, matches the Worker
  precomputed.push({ q, pooledVectorResults, keywordResults });
  console.log(`  [${i + 1}/${goldenQueries.length}] (${q.class}) "${q.query.slice(0, 44)}" -> ${pooledVectorResults.length} pooled hits, ${embeddings.length} variants`);
}

// ---- scale sanity check (bge cosines top ~0.67 -> pooled/127 should land ~0.5-0.7) ----
const sample = precomputed[0];
const topCosine = sample.pooledVectorResults[0].score / 127;
console.log(`\nscale check: sample "${sample.q.query.slice(0, 40)}" top pooled=${sample.pooledVectorResults[0].score.toFixed(2)} -> implied cosine ${topCosine.toFixed(4)}`);
if (topCosine < 0.3 || topCosine > 1.05) {
  console.error(`FATAL: top implied cosine ${topCosine.toFixed(4)} outside [0.3, 1.05] — scale assumption wrong.`);
  process.exit(1);
}

// ---- metrics ----
function recallAt10(ranked, relevantIds) {
  const top = new Set(ranked.slice(0, TOP_K).map((r) => r.id));
  let hits = 0;
  for (const id of relevantIds) if (top.has(id)) hits += 1;
  return hits / relevantIds.length;
}
function windowRecall(ranked, relevantIds) {
  const win = new Set(ranked.slice(0, RERANK_WINDOW).map((r) => r.id));
  let hits = 0;
  for (const id of relevantIds) if (win.has(id)) hits += 1;
  return hits / relevantIds.length;
}
function mean(v) {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ---- run one grid cell over the broad queries (full hybrid: keyword ⊕ vector) ----
function runCell(absFloor, relFloor) {
  const perQuery = [];
  const counts = [];
  for (const { q, pooledVectorResults, keywordResults } of precomputed) {
    const afterAbs = absFloor ? applyAbsoluteVectorFloor(pooledVectorResults, absFloor) : pooledVectorResults;
    const vectorResults = afterAbs.slice(0, VECTOR_SLICE);
    const merged = mergeHybridResults(keywordResults, vectorResults, "broad");
    const ranked = relFloor ? applyRelativeFloor(merged, relFloor, BROAD_FLOOR_MIN_KEEP) : merged;
    counts.push(ranked.length);
    const relevantIds = q.relevant.map((r) => r.id);
    perQuery.push({
      class: q.class,
      recall10: recallAt10(ranked, relevantIds),
      windowRecall: windowRecall(ranked, relevantIds),
    });
  }
  const classes = [...new Set(perQuery.map((r) => r.class))].sort();
  const byClass = {};
  for (const cls of classes) {
    const rows = perQuery.filter((r) => r.class === cls);
    byClass[cls] = {
      recall10: Number(mean(rows.map((r) => r.recall10)).toFixed(4)),
      windowRecall: Number(mean(rows.map((r) => r.windowRecall)).toFixed(4)),
    };
  }
  const sorted = [...counts].sort((a, b) => a - b);
  return {
    absFloor,
    relFloor,
    overall: {
      recall10: Number(mean(perQuery.map((r) => r.recall10)).toFixed(4)),
      windowRecall: Number(mean(perQuery.map((r) => r.windowRecall)).toFixed(4)),
    },
    byClass,
    broadTail: { n: counts.length, medianResultCount: percentile(sorted, 50), p90ResultCount: percentile(sorted, 90) },
  };
}

console.log("sweeping grid…");
const grid = [];
for (const abs of ABS_FLOOR_GRID) for (const rel of REL_FLOOR_GRID) grid.push(runCell(abs, rel));

const noFloor = grid.find((c) => c.absFloor === null && c.relFloor === null);

// preservation: BOTH window-recall AND pre-rerank recall@10 >= no-floor, on EVERY broad class.
function preserved(cell) {
  return Object.keys(noFloor.byClass).every((cls) => {
    const c = cell.byClass[cls];
    const r = noFloor.byClass[cls];
    return c.windowRecall >= r.windowRecall && c.recall10 >= r.recall10;
  });
}
function pickSmallestTail(cells) {
  return [...cells].sort((a, b) => {
    if (a.broadTail.medianResultCount !== b.broadTail.medianResultCount)
      return a.broadTail.medianResultCount - b.broadTail.medianResultCount;
    if ((a.absFloor ?? 0) !== (b.absFloor ?? 0)) return (b.absFloor ?? 0) - (a.absFloor ?? 0);
    return (b.relFloor ?? 0) - (a.relFloor ?? 0);
  })[0];
}

const candidates = grid.filter((c) => !(c.absFloor === null && c.relFloor === null)).filter(preserved);
const selected = candidates.length ? pickSmallestTail(candidates) : noFloor;
const selectionMode = candidates.length ? "per-class-preserved" : "NONE — no floored cell preserved recall; falling back to no-floor";

// ---- print ----
console.log("\n=== broad-tail median by cell (abs rows x rel cols) ===");
console.log("abs\\rel".padEnd(8) + REL_FLOOR_GRID.map((r) => (r === null ? "none" : r.toFixed(2)).padStart(7)).join(""));
for (const abs of ABS_FLOOR_GRID) {
  const label = (abs === null ? "none" : abs.toFixed(2)).padEnd(8);
  const row = REL_FLOOR_GRID.map((rel) => {
    const c = grid.find((g) => g.absFloor === abs && g.relFloor === rel);
    return String(c.broadTail.medianResultCount).padStart(7);
  }).join("");
  console.log(label + row);
}

console.log(`\nno-floor cell: recall@10=${noFloor.overall.recall10} windowRecall=${noFloor.overall.windowRecall} broad-tail median=${noFloor.broadTail.medianResultCount} p90=${noFloor.broadTail.p90ResultCount}`);
console.log(`selection: ${selectionMode}`);
console.log(`SELECTED: absFloor=${selected.absFloor ?? "none"} relFloor=${selected.relFloor ?? "none"} -> recall@10=${selected.overall.recall10} windowRecall=${selected.overall.windowRecall} broad-tail median=${selected.broadTail.medianResultCount} p90=${selected.broadTail.p90ResultCount}`);
console.log("per-class (selected vs no-floor):");
for (const cls of Object.keys(selected.byClass).sort()) {
  const c = selected.byClass[cls];
  const r = noFloor.byClass[cls];
  console.log(`  ${cls.padEnd(14)} recall@10 ${c.recall10} (base ${r.recall10})  windowRecall ${c.windowRecall} (base ${r.windowRecall})`);
}

await mkdir(dirname(SWEEP_OUT_PATH), { recursive: true });
await writeFile(
  SWEEP_OUT_PATH,
  JSON.stringify({ generated_at: new Date().toISOString(), model: index.model, abs_floor_grid: ABS_FLOOR_GRID, rel_floor_grid: REL_FLOOR_GRID, no_floor_cell: noFloor, selection_mode: selectionMode, selected_cell: selected, grid }, null, 2) + "\n",
);
console.log(`\nwrote ${SWEEP_OUT_PATH}`);
console.log(`\nCHOSEN CONSTANTS: BGE_BROAD_VECTOR_COSINE_FLOOR = ${selected.absFloor ?? 0}, BGE_BROAD_MERGED_RELATIVE_FLOOR = ${selected.relFloor ?? 0}`);
