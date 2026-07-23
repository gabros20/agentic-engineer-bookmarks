// Re-embed the whole corpus with Workers AI @cf/baai/bge-m3 for the server-side
// (Cloudflare Worker) search — Task 1. Mirrors scripts/build-search-index.mjs's chunk/item
// structure EXACTLY (same searchText + chunkArticle + quantizeEmbedding from scripts/lib/
// embed.mjs, same {id, part?} shape, same empty-text fallback), with ONE deliberate
// difference: bge-m3 takes RAW text — NO e5 "query:"/"passage:" prefixes (see
// .orchestrate/spike-findings.md). So this builds items without passageText(): the main
// vector embeds the raw searchText (or the raw post id as the textless fallback), and each
// article chunk embeds the raw chunk. Output: public/data/search-index-bge.json
// (1024-dim, int8_normalized, schema_version "3.0", NO prefix_scheme field).
//
// Inference runs through the local spike worker's POST /embed route (Workers AI runs
// remotely even under `wrangler dev`): start `npx wrangler dev --port 8787` in worker/,
// wait for "Ready on", then run this. Resumable: re-running only embeds (id,part) pairs
// absent from an existing output, and progress is flushed atomically every FLUSH_EVERY
// batches, so an interrupted run picks up where it left off.

import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";
import { searchText, chunkArticle, quantizeEmbedding } from "./lib/embed.mjs";

const MODEL = "@cf/baai/bge-m3";
const DIMENSIONS = 1024;
// bge-m3 counts the WHOLE request's tokens against a single 60k-token context window (a
// 64-text batch of full-article mains hit 329k tokens → HTTP 500 "Max context reached").
// The tokenizer (XLM-RoBERTa sentencepiece) can be dense on CJK/mixed text — empirically up
// to ~2.2 tokens/char (a 90k-char batch tokenized to 200k tokens). So batch by a
// conservative CHARACTER budget: 15k chars/request → ~33k tokens even at that worst-case
// density, comfortably under 60k, with a hard count cap for the many-short-texts case.
const MAX_BATCH_CHARS = 15000;
const MAX_BATCH_COUNT = 64;
// bge-m3 hard-errors ("3030: invalid input") on any single text over its max sequence
// length — an article post's MAIN text is tweet + articleTitle + FULL articleText (up to
// tens of thousands of chars) via searchText(). The worker /embed route passes
// truncate_inputs:true so the endpoint truncates oversized inputs to the model max instead
// of erroring; this char cap is a belt-and-suspenders pre-truncation so the script is robust
// regardless. 6000 chars comfortably exceeds e5's old effective 512-token (~2-3k char)
// window, and each article's full body is still embedded via its separate chunk part-vectors.
const PER_TEXT_CHAR_CAP = 6000;
const FLUSH_EVERY = 10; // save progress every N batches (atomic temp+rename)
const EMBED_URL = process.env.EMBED_URL ?? "http://localhost:8787/embed";
// Workers AI occasionally returns a transient "3030: invalid input" for a few seconds even
// on valid text; ride it out with more retries + longer backoff (up to ~31s per batch).
const MAX_RETRIES = 8;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "public/data/all-bookmarks.json");
const outputPath = join(root, "public/data/search-index-bge.json");
const tmpPath = `${outputPath}.tmp`;

const specKey = (id, part) => `${id}::${part ?? "main"}`;

/**
 * Strip lone/unpaired UTF-16 surrogate code units. Some archived posts contain broken
 * surrogates (malformed source data), and slicing a text mid-pair at the char cap can also
 * orphan one — either way the string can't encode to valid UTF-8, and the Workers AI
 * endpoint rejects it ("3030: invalid input") where e5's local transformers.js tokenizer
 * silently tolerated it. Valid surrogate PAIRS (emoji, non-BMP chars) are preserved.
 */
function stripLoneSurrogates(s) {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/**
 * Items to embed for a post, mirroring embedItemsForPost() from scripts/lib/embed.mjs but
 * with RAW text (no "passage: " prefix) since bge-m3 uses no e5-style prefixes. Same {id,
 * part?} structure and same empty-searchText fallback (raw post.id instead of "passage:
 * <id>") so a text-less post doesn't collapse onto an identical embedding.
 */
function rawItemsForPost(post) {
  // bge-m3 rejects empty/whitespace-only input ("3030: invalid input"), so guarantee every
  // text is non-empty — mirroring the e5 pipeline's `text || post.id` fallback. Then cap
  // length so no single text can blow the 60k-token request limit on its own.
  const safe = (t) => {
    const trimmed = typeof t === "string" ? t.trim() : "";
    const nonEmpty = trimmed || post.id;
    const capped = nonEmpty.length > PER_TEXT_CHAR_CAP ? nonEmpty.slice(0, PER_TEXT_CHAR_CAP) : nonEmpty;
    return stripLoneSurrogates(capped);
  };
  const items = [{ id: post.id, text: safe(searchText(post)) }];
  if (post.articleText && post.articleText.trim()) {
    const chunks = chunkArticle(post.articleText, post.articleTitle);
    chunks.forEach((chunk, i) => {
      items.push({ id: post.id, part: i + 1, text: safe(chunk) });
    });
  }
  return items;
}

/** Build the on-disk index object from the canonical spec order + an embeddings map. */
function buildIndex(specs, embMap) {
  const items = [];
  for (const spec of specs) {
    const embedding = embMap.get(specKey(spec.id, spec.part));
    if (!embedding) continue; // not yet embedded (partial progress)
    items.push(spec.part !== undefined ? { id: spec.id, part: spec.part, embedding } : { id: spec.id, embedding });
  }
  const uniqueIdCount = new Set(items.map((it) => it.id)).size;
  return {
    ok: true,
    schema_version: "3.0",
    generated_at: new Date().toISOString(),
    source: "public/data/all-bookmarks.json",
    model: MODEL,
    dimensions: DIMENSIONS,
    encoding: "int8_normalized",
    count: uniqueIdCount,
    vector_count: items.length,
    items,
  };
}

async function flush(specs, embMap) {
  const index = buildIndex(specs, embMap);
  await writeFile(tmpPath, JSON.stringify(index));
  await rename(tmpPath, outputPath); // atomic on same filesystem
  return index;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One HTTP call to /embed; throws on any non-happy response. */
async function embedRequest(texts) {
  const res = await fetch(EMBED_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // The worker /embed route is gated behind EMBED_SECRET (must match worker/.dev.vars).
      ...(process.env.EMBED_SECRET ? { "X-Embed-Secret": process.env.EMBED_SECRET } : {}),
    },
    body: JSON.stringify({ texts }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const { vectors, error } = await res.json();
  if (error) throw new Error(`worker error: ${error}`);
  if (!Array.isArray(vectors) || vectors.length !== texts.length) {
    throw new Error(`expected ${texts.length} vectors, got ${Array.isArray(vectors) ? vectors.length : typeof vectors}`);
  }
  if (vectors[0]?.length !== DIMENSIONS) {
    throw new Error(`expected ${DIMENSIONS}-dim vectors, got ${vectors[0]?.length}`);
  }
  return vectors;
}

async function embedWithRetries(texts, maxRetries) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await embedRequest(texts);
    } catch (err) {
      lastErr = err;
      const backoff = Math.min(16000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 400);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

/**
 * Embed a batch, self-healing around Workers AI's intermittent "3030: invalid input" (the
 * SAME batch that fails a burst of retries embeds fine moments later, and single-text
 * requests reliably succeed — so it's transient upstream flakiness, not bad content). On a
 * batch that exhausts its retries, recursively split and retry the halves down to singles;
 * order is preserved by concatenating in order. A single text that still fails after retries
 * is a genuine error and throws (the run is resumable, so a later re-run picks up from the
 * last flush).
 */
async function embedBatch(texts) {
  try {
    return await embedWithRetries(texts, MAX_RETRIES);
  } catch (err) {
    if (texts.length === 1) {
      throw new Error(`single text failed after ${MAX_RETRIES} attempts (len ${texts[0].length}): ${err}`);
    }
    console.warn(`  batch of ${texts.length} failed (${err}); splitting and retrying halves`);
    const mid = Math.ceil(texts.length / 2);
    const head = await embedBatch(texts.slice(0, mid));
    const tail = await embedBatch(texts.slice(mid));
    return [...head, ...tail];
  }
}

async function main() {
  const payload = JSON.parse(await readFile(sourcePath, "utf8"));
  const posts = normalizeBookmarkPayload(payload);

  const specs = posts.flatMap(rawItemsForPost);
  console.log(`Corpus: ${posts.length} posts → ${specs.length} vectors to embed (main + article chunks).`);

  // Resume: preload embeddings already on disk.
  const embMap = new Map();
  if (existsSync(outputPath)) {
    try {
      const prev = JSON.parse(await readFile(outputPath, "utf8"));
      for (const item of prev.items ?? []) {
        if (Array.isArray(item.embedding) && item.embedding.length === DIMENSIONS) {
          embMap.set(specKey(item.id, item.part), item.embedding);
        }
      }
      console.log(`Resuming: ${embMap.size} vectors already present in ${outputPath}.`);
    } catch (err) {
      console.warn(`Could not read existing output (${err}); starting fresh.`);
    }
  }

  // One pass over the still-pending specs. Greedy char-budget batching (see MAX_BATCH_CHARS).
  // Throws if any batch ultimately fails (self-healing splits are inside embedBatch); the
  // outer pass loop below catches that, flushes, waits, and retries the remaining specs.
  async function embedPass() {
    const pending = specs.filter((s) => !embMap.has(specKey(s.id, s.part)));
    const batches = [];
    let cur = [];
    let curChars = 0;
    for (const spec of pending) {
      if (cur.length && (curChars + spec.text.length > MAX_BATCH_CHARS || cur.length >= MAX_BATCH_COUNT)) {
        batches.push(cur);
        cur = [];
        curChars = 0;
      }
      cur.push(spec);
      curChars += spec.text.length;
    }
    if (cur.length) batches.push(cur);
    console.log(`${pending.length} vectors to embed across ${batches.length} char-budget batches.`);

    let done = 0;
    for (let b = 0; b < batches.length; b += 1) {
      const batch = batches[b];
      const vectors = await embedBatch(batch.map((s) => s.text));
      batch.forEach((spec, j) => {
        embMap.set(specKey(spec.id, spec.part), quantizeEmbedding(vectors[j]));
      });
      done += batch.length;
      if ((b + 1) % FLUSH_EVERY === 0 || b === batches.length - 1) {
        await flush(specs, embMap);
        console.log(`  batch ${b + 1}/${batches.length} (${done}/${pending.length} vectors); flushed.`);
      }
    }
  }

  // Outer resume loop: Workers AI intermittently returns "3030: invalid input" in bursts for
  // otherwise-valid text (the same text embeds fine seconds later). A single hard failure
  // shouldn't abort the whole re-embed, so retry the remaining specs across multiple passes,
  // flushing progress each time — every pass strictly advances since embedded specs are
  // skipped. Completes within one invocation without needing an external re-run.
  const MAX_PASSES = 12;
  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    const before = embMap.size;
    try {
      await embedPass();
    } catch (err) {
      await flush(specs, embMap);
      const remaining = specs.filter((s) => !embMap.has(specKey(s.id, s.part))).length;
      console.warn(`Pass ${pass} interrupted (${err}); flushed. ${remaining} vectors remain; retrying after backoff.`);
      await sleep(10000);
    }
    const remaining = specs.filter((s) => !embMap.has(specKey(s.id, s.part)));
    if (!remaining.length) break;
    if (embMap.size === before && pass > 1) {
      // No progress this pass at all — back off harder before the next attempt.
      await sleep(15000);
    }
  }

  const stillMissing = specs.filter((s) => !embMap.has(specKey(s.id, s.part)));
  if (stillMissing.length) {
    await flush(specs, embMap);
    throw new Error(`${stillMissing.length} vectors still unembedded after ${MAX_PASSES} passes (e.g. ${stillMissing[0].key ?? specKey(stillMissing[0].id, stillMissing[0].part)}); re-run to resume.`);
  }

  const index = await flush(specs, embMap);
  console.log(`Wrote ${outputPath} — ${index.count} posts, ${index.vector_count} vectors, ${index.dimensions}-dim ${index.encoding}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
