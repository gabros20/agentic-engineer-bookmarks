import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "@huggingface/transformers";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "public/data/all-bookmarks.json");
const outputPath = join(root, "public/data/search-index.json");
const model = "Xenova/all-MiniLM-L6-v2";

function searchText(post) {
  return [
    post.text,
    post.articleTitle,
    post.articleText,
    post.author?.name,
    post.author?.screenName,
    ...(post.urls ?? []),
    post.quotedTweet?.text,
    post.quotedTweet?.author?.name,
    post.quotedTweet?.author?.screenName,
  ]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function quantizeEmbedding(data) {
  return Array.from(data, (value) => Math.max(-127, Math.min(127, Math.round(value * 127))));
}

const payload = JSON.parse(await readFile(sourcePath, "utf8"));
const posts = payload.data ?? [];
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
