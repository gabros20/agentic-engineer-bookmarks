import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";
import {
  EMBED_MODEL as model,
  PREFIX_SCHEME as prefixScheme,
  embedItemsForPost,
  quantizeEmbedding,
} from "./lib/embed.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "public/data/all-bookmarks.json");
const outputPath = join(root, "public/data/search-index.json");

const payload = JSON.parse(await readFile(sourcePath, "utf8"));
const posts = normalizeBookmarkPayload(payload);
const extractor = await pipeline("feature-extraction", model);
const items = [];

for (const [index, post] of posts.entries()) {
  for (const entry of embedItemsForPost(post)) {
    const output = await extractor(entry.text, { pooling: "mean", normalize: true });
    const embedding = quantizeEmbedding(output.data);
    items.push(
      entry.part !== undefined ? { id: post.id, part: entry.part, embedding } : { id: post.id, embedding },
    );
  }

  if ((index + 1) % 25 === 0 || index === posts.length - 1) {
    console.log(`Embedded ${index + 1}/${posts.length}`);
  }
}

// count = unique bookmark ids (aligned with scripts/embed-new.mjs), vector_count = total
// items (main + chunk vectors). Computed from `items`, not `posts.length`, so a future
// duplicate id in the source archive can't silently inflate `count` past the real id count.
const uniqueIdCount = new Set(items.map((it) => it.id)).size;

await writeFile(
  outputPath,
  JSON.stringify({
    ok: true,
    schema_version: "2.0",
    generated_at: new Date().toISOString(),
    source: "public/data/all-bookmarks.json",
    model,
    prefix_scheme: prefixScheme,
    dimensions: items[0]?.embedding.length ?? 0,
    encoding: "int8_normalized",
    count: uniqueIdCount,
    vector_count: items.length,
    items,
  }),
);

console.log(`Wrote ${outputPath} (${uniqueIdCount} posts, ${items.length} vectors)`);
