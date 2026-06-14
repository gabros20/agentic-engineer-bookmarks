import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";
import { EMBED_MODEL as model, quantizeEmbedding, searchText } from "./lib/embed.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "public/data/all-bookmarks.json");
const outputPath = join(root, "public/data/search-index.json");

const payload = JSON.parse(await readFile(sourcePath, "utf8"));
const posts = normalizeBookmarkPayload(payload);
const extractor = await pipeline("feature-extraction", model);
const items = [];

for (const [index, post] of posts.entries()) {
  const text = searchText(post);
  const output = await extractor(text || post.id, { pooling: "mean", normalize: true });
  items.push({
    id: post.id,
    embedding: quantizeEmbedding(output.data),
  });

  if ((index + 1) % 25 === 0 || index === posts.length - 1) {
    console.log(`Embedded ${index + 1}/${posts.length}`);
  }
}

await writeFile(
  outputPath,
  JSON.stringify({
    ok: true,
    schema_version: "1.0",
    generated_at: new Date().toISOString(),
    source: "public/data/all-bookmarks.json",
    model,
    dimensions: items[0]?.embedding.length ?? 0,
    encoding: "int8_normalized",
    count: items.length,
    items,
  }),
);

console.log(`Wrote ${outputPath}`);
