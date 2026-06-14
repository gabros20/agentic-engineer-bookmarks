// Incremental embeddings: embed ONLY bookmarks not already in search-index.json,
// then append them. Run after `xrelay archive bookmarks --out ...` adds new posts.
// A full rebuild is `scripts/build-search-index.mjs`; this is the fast top-up.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";
import { EMBED_MODEL as model, quantizeEmbedding, searchText } from "./lib/embed.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "public/data/all-bookmarks.json");
const indexPath = join(root, "public/data/search-index.json");

const payload = JSON.parse(await readFile(sourcePath, "utf8"));
const posts = normalizeBookmarkPayload(payload);

let index;
try {
  index = JSON.parse(await readFile(indexPath, "utf8"));
} catch {
  index = null;
}

if (!index || !Array.isArray(index.items)) {
  console.error("No existing search-index.json — run `npm run build:index` for a full build first.");
  process.exit(1);
}

const embedded = new Set(index.items.map((it) => it.id));
const fresh = posts.filter((p) => !embedded.has(p.id));

if (fresh.length === 0) {
  console.log("Embeddings already up to date — nothing to embed.");
  process.exit(0);
}

console.log(`Embedding ${fresh.length} new post(s) (index has ${index.items.length})…`);
const extractor = await pipeline("feature-extraction", model);
const added = [];

for (const [i, post] of fresh.entries()) {
  const text = searchText(post);
  const output = await extractor(text || post.id, { pooling: "mean", normalize: true });
  added.push({ id: post.id, embedding: quantizeEmbedding(output.data) });
  if ((i + 1) % 25 === 0 || i === fresh.length - 1) {
    console.log(`Embedded ${i + 1}/${fresh.length}`);
  }
}

// Prepend new items (newest-first, mirroring the archive order).
const items = [...added, ...index.items];

await writeFile(
  indexPath,
  JSON.stringify({
    ok: true,
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    source: "public/data/all-bookmarks.json",
    model,
    dimensions: items[0]?.embedding.length ?? index.dimensions ?? 0,
    encoding: "int8_normalized",
    count: items.length,
    items,
  }),
);

console.log(`Added ${added.length} embedding(s); index now ${items.length}. Wrote ${indexPath}`);
