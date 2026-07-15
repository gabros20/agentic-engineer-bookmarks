// Sweep script for T1.3 broad-mode relevance floors.
//
// Loads the archive + the CURRENT search index (must be the v2 e5 index — asserts
// `prefix_scheme === "e5"`, exits 1 otherwise, since cosine distributions are
// model-specific and calibrating against the wrong model would produce meaningless
// constants), then runs every golden query through the production pipeline once to
// precompute keyword results + pooled (max-pooled, UNSLICED) vector results per query.
//
// For each grid cell (absolute cosine floor x relative merged floor) it replays the
// broad-mode pipeline over the precomputed data — absolute floor -> slice(0,900) -> RRF
// merge -> relative floor — exactly matching the order wired into
// components/bookmarks-app.tsx and scripts/eval-search.mjs. Exact-mode queries are
// unaffected by either floor (computed once, reused for every cell).
//
// Prints the sweep table, writes the full grid to .orchestrate/raw/task6-sweep.json
// (not committed — regenerable), and prints the selected cell + rationale per the
// selection rule in .orchestrate/task-6-brief.md.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";
import {
  applyAbsoluteVectorFloor,
  applyRelativeFloor,
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
const SWEEP_OUT_PATH = join(root, ".orchestrate/raw/task6-sweep.json");

const TOP_K = 10;
const VECTOR_SLICE = 900; // matches components/bookmarks-app.tsx / scripts/eval-search.mjs
const EXACT_FLOOR = 0.5; // matches components/bookmarks-app.tsx / scripts/eval-search.mjs

// null = "none" (no floor). Absolute grid: none, 0.70..0.90 step 0.02.
const ABS_FLOOR_GRID = [null, 0.7, 0.72, 0.74, 0.76, 0.78, 0.8, 0.82, 0.84, 0.86, 0.88, 0.9];
// Relative grid: none, 0.10..0.50 step 0.05.
const REL_FLOOR_GRID = [null, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];

console.log("loading data…");
const [bookmarksPayload, index, goldenQueries] = await Promise.all([
  readFile(BOOKMARKS_PATH, "utf8").then(JSON.parse),
  readFile(INDEX_PATH, "utf8").then(JSON.parse),
  readFile(QUERIES_PATH, "utf8").then(JSON.parse),
]);

if (index.prefix_scheme !== "e5") {
  console.error(
    `FATAL: current index (${INDEX_PATH}) has prefix_scheme=${JSON.stringify(index.prefix_scheme)}, expected "e5".\n` +
      `Broad-mode floor calibration is only meaningful against the v2 e5 index (cosine distributions are ` +
      `model-specific). Rebuild the index (npm run build:search) before calibrating.`,
  );
  process.exit(1);
}

const posts = normalizeBookmarkPayload(bookmarksPayload);
console.log(`archive: ${posts.length} posts; index: ${index.count} bookmarks, ${index.items.length} vectors (model=${index.model})`);

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

// ---- precompute keyword + pooled (unsliced) vector results per golden query ----

console.log(`precomputing ${goldenQueries.length} golden queries (keyword + pooled vectors)…`);
const precomputed = [];
for (const [i, q] of goldenQueries.entries()) {
  const keywordResults = keywordSearch(keywordIndex, q.query);
  const expandedQueries = expandSemanticQueries(q.query, q.precision);
  const embeddings = await embedQueries(expandedQueries);
  const pooledVectorResults = multiVectorSearch(index, embeddings); // pooled per-id, UNSLICED
  precomputed.push({ q, keywordResults, pooledVectorResults });
  console.log(`[${i + 1}/${goldenQueries.length}] (${q.class}/${q.precision}) "${q.query.slice(0, 50)}" -> ${pooledVectorResults.length} pooled vector hits`);
}

// ---- scale sanity check (brief requirement: verify the 127x int8 scale empirically) ----

console.log("\n=== scale sanity check ===");
const sample = precomputed.find((p) => p.q.precision === "broad") ?? precomputed[0];
console.log(`sample query: "${sample.q.query}"`);
for (const r of sample.pooledVectorResults.slice(0, 5)) {
  console.log(`  id=${r.id} raw_dot=${r.score.toFixed(3)} implied_cosine(dot/127)=${(r.score / 127).toFixed(4)}`);
}
const topCosine = sample.pooledVectorResults[0].score / 127;
if (topCosine < 0.3 || topCosine > 1.05) {
  console.error(
    `FATAL: top pooled score / 127 = ${topCosine.toFixed(4)} is outside the plausible cosine range [0.3, 1.05] — ` +
      `the dot ≈ 127*cosine scale assumption looks wrong. Recalibrate the grid before trusting this sweep.`,
  );
  process.exit(1);
}
console.log(`top-hit implied cosine (${topCosine.toFixed(4)}) is in the plausible range — scale assumption (dot ≈ 127 * cosine) holds.\n`);

// ---- exact-mode results computed ONCE (floors never touch exact mode) ----

const exactResultsByQuery = new Map();
for (const entry of precomputed) {
  if (entry.q.precision !== "exact") continue;
  const vectorResults = entry.pooledVectorResults.slice(0, VECTOR_SLICE);
  const merged = mergeHybridResults(entry.keywordResults, vectorResults, "exact");
  exactResultsByQuery.set(entry.q.query, applyRelativeFloor(merged, EXACT_FLOOR));
}

// ---- metrics helpers (mirrors scripts/eval-search.mjs) ----

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

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.ceil((p / 100) * sortedValues.length) - 1);
  return sortedValues[Math.max(0, idx)];
}

// ---- run one grid cell ----

function runCell(absFloor, relFloor) {
  const perQuery = [];
  const broadResultCounts = [];

  for (const entry of precomputed) {
    const { q } = entry;
    let ranked;
    if (q.precision === "exact") {
      ranked = exactResultsByQuery.get(q.query);
    } else {
      const afterAbs = absFloor ? applyAbsoluteVectorFloor(entry.pooledVectorResults, absFloor) : entry.pooledVectorResults;
      const vectorResults = afterAbs.slice(0, VECTOR_SLICE);
      const merged = mergeHybridResults(entry.keywordResults, vectorResults, "broad");
      ranked = relFloor ? applyRelativeFloor(merged, relFloor) : merged;
      broadResultCounts.push(ranked.length);
    }
    const relevantIds = q.relevant.map((r) => r.id);
    const relevantSet = new Set(relevantIds);
    perQuery.push({
      query: q.query,
      class: q.class,
      precision: q.precision,
      recall10: recallAt10(ranked, relevantIds),
      mrr10: mrrAt10(ranked, relevantSet),
    });
  }

  const classes = [...new Set(perQuery.map((r) => r.class))].sort();
  const byClass = {};
  for (const cls of classes) {
    const rows = perQuery.filter((r) => r.class === cls);
    byClass[cls] = {
      n: rows.length,
      recall10: Number(mean(rows.map((r) => r.recall10)).toFixed(4)),
      mrr10: Number(mean(rows.map((r) => r.mrr10)).toFixed(4)),
    };
  }
  const overall = {
    n: perQuery.length,
    recall10: Number(mean(perQuery.map((r) => r.recall10)).toFixed(4)),
    mrr10: Number(mean(perQuery.map((r) => r.mrr10)).toFixed(4)),
  };

  const sortedBroadCounts = [...broadResultCounts].sort((a, b) => a - b);
  const broadTail = {
    n: broadResultCounts.length,
    medianResultCount: percentile(sortedBroadCounts, 50),
    p90ResultCount: percentile(sortedBroadCounts, 90),
  };

  return { absFloor, relFloor, overall, byClass, broadTail };
}

// ---- sweep the grid ----

console.log("sweeping grid…");
const grid = [];
for (const absFloor of ABS_FLOOR_GRID) {
  for (const relFloor of REL_FLOOR_GRID) {
    grid.push(runCell(absFloor, relFloor));
  }
}

const noFloorCell = grid.find((c) => c.absFloor === null && c.relFloor === null);
if (!noFloorCell) throw new Error("no-floor (null, null) cell missing from grid — grid construction bug");

// ---- selection rule ----
// Candidates: every class's recall10 AND mrr10 >= the no-floor cell's, on EVERY class.
// Among candidates (excluding the trivial no-floor cell itself, which always trivially
// qualifies but defeats the point), pick smallest broad-tail median; tie-break larger
// absolute floor, then larger relative floor (both shrink the tail further; not
// brief-specified but a natural, reversible extension of "tie-break on larger absolute
// floor" — noted in the report).

function classesPreserved(cell, reference) {
  return Object.keys(reference.byClass).every((cls) => {
    const c = cell.byClass[cls];
    const r = reference.byClass[cls];
    return c.recall10 >= r.recall10 && c.mrr10 >= r.mrr10;
  });
}

function overallPreserved(cell, reference) {
  return cell.overall.recall10 >= reference.overall.recall10 && cell.overall.mrr10 >= reference.overall.mrr10;
}

function pickSmallestTail(cells) {
  return [...cells].sort((a, b) => {
    if (a.broadTail.medianResultCount !== b.broadTail.medianResultCount) {
      return a.broadTail.medianResultCount - b.broadTail.medianResultCount;
    }
    const aAbs = a.absFloor ?? 0;
    const bAbs = b.absFloor ?? 0;
    if (aAbs !== bAbs) return bAbs - aAbs; // larger absolute floor wins ties
    const aRel = a.relFloor ?? 0;
    const bRel = b.relFloor ?? 0;
    return bRel - aRel; // then larger relative floor
  })[0];
}

const nonTrivialCells = grid.filter((c) => !(c.absFloor === null && c.relFloor === null));
const strictCandidates = nonTrivialCells.filter((c) => classesPreserved(c, noFloorCell));

let selected;
let selectionMode;
if (strictCandidates.length) {
  selected = pickSmallestTail(strictCandidates);
  selectionMode = "per-class-preserved";
} else {
  const relaxedCandidates = nonTrivialCells.filter((c) => overallPreserved(c, noFloorCell));
  if (relaxedCandidates.length) {
    selected = pickSmallestTail(relaxedCandidates);
    selectionMode = "overall-preserved (RELAXED — per-class could not be preserved)";
  } else {
    selected = noFloorCell;
    selectionMode = "NONE — even overall metrics could not be preserved by any floored cell; falling back to no-floor";
  }
}

// ---- print compact table (only the diagonal-relevant + selected cell + no-floor for brevity) ----

console.log("\n=== sweep grid (overall recall@10 / mrr@10 / broad-tail median,p90) ===");
console.log("abs\\rel".padEnd(8) + REL_FLOOR_GRID.map((r) => (r === null ? "none" : r.toFixed(2))).map((s) => s.padStart(8)).join(""));
for (const absFloor of ABS_FLOOR_GRID) {
  const label = (absFloor === null ? "none" : absFloor.toFixed(2)).padEnd(8);
  const cells = REL_FLOOR_GRID.map((relFloor) => grid.find((c) => c.absFloor === absFloor && c.relFloor === relFloor));
  const row = cells.map((c) => `${c.broadTail.medianResultCount}`.padStart(8)).join("");
  console.log(label + row);
}
console.log("(cell values = broad-tail median result count; see .orchestrate/raw/task6-sweep.json for full recall/mrr/p90 per cell)\n");

console.log(`no-floor cell: overall recall@10=${noFloorCell.overall.recall10} mrr@10=${noFloorCell.overall.mrr10} broad-tail median=${noFloorCell.broadTail.medianResultCount} p90=${noFloorCell.broadTail.p90ResultCount}`);
console.log(`selection mode: ${selectionMode}`);
console.log(
  `selected cell: absFloor=${selected.absFloor ?? "none"} relFloor=${selected.relFloor ?? "none"} -> overall recall@10=${selected.overall.recall10} mrr@10=${selected.overall.mrr10} broad-tail median=${selected.broadTail.medianResultCount} p90=${selected.broadTail.p90ResultCount}`,
);
console.log("per-class (selected cell):");
for (const cls of Object.keys(selected.byClass).sort()) {
  const c = selected.byClass[cls];
  const r = noFloorCell.byClass[cls];
  console.log(`  ${cls.padEnd(14)} recall@10 ${c.recall10} (base ${r.recall10})  mrr@10 ${c.mrr10} (base ${r.mrr10})`);
}

// ---- write full sweep to raw log (not committed) ----

await mkdir(dirname(SWEEP_OUT_PATH), { recursive: true });
await writeFile(
  SWEEP_OUT_PATH,
  JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      model: index.model,
      prefix_scheme: index.prefix_scheme,
      abs_floor_grid: ABS_FLOOR_GRID,
      rel_floor_grid: REL_FLOOR_GRID,
      no_floor_cell: noFloorCell,
      selection_mode: selectionMode,
      selected_cell: selected,
      grid,
    },
    null,
    2,
  ) + "\n",
);
console.log(`\nwrote full sweep grid -> ${SWEEP_OUT_PATH}`);
console.log(
  `\nCHOSEN CONSTANTS: BROAD_VECTOR_COSINE_FLOOR = ${selected.absFloor ?? 0}, BROAD_MERGED_RELATIVE_FLOOR = ${selected.relFloor ?? 0}`,
);
