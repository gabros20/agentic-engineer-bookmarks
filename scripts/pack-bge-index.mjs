// Pack public/data/search-index-bge.json (17.7 MB of JSON int8 arrays) into a compact
// binary the Cloudflare search Worker can load once per isolate WITHOUT re-parsing 6,840
// nested number[] arrays on every cold start (T2). Outputs:
//   - search-index-bge.bin       row-major Int8 [vector_count × dimensions], one row per item
//   - search-index-bge.meta.json { model, dimensions, count, vector_count, items:[{id, part?}] }
//     in the SAME row order as the .bin.
// The Worker reads the .bin as an ArrayBuffer → Int8Array and slices each row as a subarray
// view (zero-copy), then feeds those views straight into lib multiVectorSearch. The int8
// values are written unchanged (still the normalized-float × 127 rounding from embed-bge.mjs),
// so the Worker's int8-dot convention matches lib/bookmark-search.ts's INT8_VECTOR_SCALE.
//
// Run from repo root: node scripts/pack-bge-index.mjs

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve("public/data/search-index-bge.json");
const BIN = resolve("public/data/search-index-bge.bin");
const META = resolve("public/data/search-index-bge.meta.json");

const idx = JSON.parse(readFileSync(SRC, "utf8"));
const { model, dimensions, count, vector_count, items } = idx;

if (!Array.isArray(items) || !items.length) throw new Error("no items in source index");
if (typeof dimensions !== "number" || dimensions <= 0) throw new Error(`bad dimensions: ${dimensions}`);
if (items.length !== vector_count) {
  throw new Error(`vector_count ${vector_count} != items.length ${items.length}`);
}

const bin = new Int8Array(items.length * dimensions);
const metaItems = new Array(items.length);

for (let r = 0; r < items.length; r += 1) {
  const it = items[r];
  const emb = it.embedding;
  if (!Array.isArray(emb) || emb.length !== dimensions) {
    throw new Error(`item ${r} (id ${it.id}) has ${emb?.length} dims, expected ${dimensions}`);
  }
  for (let d = 0; d < dimensions; d += 1) {
    const v = emb[d];
    if (v < -128 || v > 127 || !Number.isInteger(v)) {
      throw new Error(`item ${r} dim ${d} value ${v} out of int8 range`);
    }
  }
  bin.set(emb, r * dimensions);
  metaItems[r] = it.part === undefined ? { id: it.id } : { id: it.id, part: it.part };
}

// Atomic (temp + rename): a sync killed mid-write must never leave a torn .bin or .meta behind.
function writeAtomic(path, data) {
  writeFileSync(`${path}.tmp`, data);
  renameSync(`${path}.tmp`, path);
}
writeAtomic(BIN, Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength));
writeAtomic(META, JSON.stringify({ model, dimensions, count, vector_count, items: metaItems }));

console.log(
  `packed ${items.length} vectors × ${dimensions} dims → ${BIN} (${(bin.byteLength / 1e6).toFixed(1)} MB), ` +
    `meta → ${META}`,
);
