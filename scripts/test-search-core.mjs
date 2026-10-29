// Lightweight unit tests for the index-schema-v2 grouping change (Task 4).
// Plain node:assert, no framework (none exists in this repo). Run via `npm run test:search`.
//
// Covers:
//  1. chunkArticle: empty / short / long / tiny-chunk merge (trailing + non-trailing orphan)
//  2. grouping identity on v1-shaped items (vectorSearch + multiVectorSearch)
//  3. max-pool correctness on synthetic multi-part items
//  4. RRF (mergeHybridResults) feeds one entry per id
//  5. embedItemsForPost item shape (bonus smoke coverage)
//  6. searchText: post.urls collapse to registrable domains (Task 5)
//  7. applyAbsoluteVectorFloor / applyRelativeFloor: broad-mode floor math (Task 6)
//  8. rerankResults / minMaxNormalize / buildRerankDocText: cross-encoder blend math via a
//     stubbed scorer (Task 11, T3.2) — the real ~23 MB model is never loaded in this file.
//  9. F2 drift guard (Task 3): the field/boost/char-cap config in lib/bookmark-search.ts and
//     lib/rerank.ts (the TS source of truth) still matches scripts/lib/search-core.mjs (the
//     Node port build-lunr-index.mjs / build-rerank-docs.mjs / eval-search.mjs all import),
//     and the two Worker-data builders still import from search-core.mjs instead of hand-
//     copying a third parallel implementation.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkArticle, embedItemsForPost, searchText } from "./lib/embed.mjs";
import {
  applyAbsoluteVectorFloor,
  applyRelativeFloor,
  buildKeywordIndex,
  buildRerankDocText,
  keywordSearch,
  mergeHybridResults,
  minMaxNormalize,
  multiVectorSearch,
  rerankResults,
  threadText,
  vectorSearch,
} from "./lib/search-core.mjs";

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok   - ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL - ${name}`);
    console.log(`       ${err.message}`);
  }
}

// rerankResults is async (it awaits a scorer), so it needs an await-ing counterpart to
// `test` above. Node ESM supports top-level await, so callers just `await testAsync(...)`.
async function testAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`ok   - ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL - ${name}`);
    console.log(`       ${err.message}`);
  }
}

function words(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function makePara(word, count) {
  return Array.from({ length: count }, () => word).join(" ");
}

// ---- 1. chunkArticle ----------------------------------------------------

test("chunkArticle: empty/whitespace/null markdown -> []", () => {
  assert.deepEqual(chunkArticle("", "Title"), []);
  assert.deepEqual(chunkArticle("   \n\n  ", "Title"), []);
  assert.deepEqual(chunkArticle(null, "Title"), []);
  assert.deepEqual(chunkArticle(undefined, "Title"), []);
});

test("chunkArticle: short article (well under target) -> single title-prefixed chunk", () => {
  const para = makePara("word", 40);
  const chunks = chunkArticle(para, "My Title");
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].startsWith("My Title: "), "chunk should be title-prefixed");
  assert.equal(words(chunks[0].slice("My Title: ".length)).length, 40);
});

test("chunkArticle: strips code fences, inline code, images, and unwraps links", () => {
  const md = [
    "Intro [link text](https://example.com/x) more words here.",
    "",
    "```js\nconst x = 1;\nfunction f() { return x; }\n```",
    "",
    "![some alt text](https://example.com/img.png)",
    "",
    "Trailing `inline code` paragraph continues after.",
  ].join("\n");
  const chunks = chunkArticle(md, "T");
  const joined = chunks.join(" ");
  assert.ok(joined.includes("link text"), "link visible text should survive");
  assert.ok(!joined.includes("example.com"), "URLs should not survive");
  assert.ok(!joined.includes("const x"), "fenced code should be stripped");
  assert.ok(!joined.includes("some alt text"), "image alt text should be stripped");
  assert.ok(!joined.includes("inline code"), "inline code should be stripped");
});

test("chunkArticle: long article splits on paragraph boundaries near the ~280-word target", () => {
  // 9 paragraphs x 100 words = 900 words -> chunks of 300,300,300 (target closes a chunk
  // once it reaches 280 words; each 3-paragraph run hits 300 before a 4th would push it
  // over, since 300 >= 280 but adding a 4th 100-word paragraph would need to check the
  // 350 hard cap first on the *next* iteration — here each triplet closes exactly at 300).
  const paras = Array.from({ length: 9 }, (_, i) => makePara(`p${i}`, 100));
  const md = paras.join("\n\n");
  const chunks = chunkArticle(md, "Long Article");

  assert.equal(chunks.length, 3, `expected 3 chunks, got ${chunks.length}`);
  const wordCounts = chunks.map((c) => words(c.slice("Long Article: ".length)).length);
  assert.deepEqual(wordCounts, [300, 300, 300]);
  assert.equal(
    wordCounts.reduce((a, b) => a + b, 0),
    900,
    "no words lost or duplicated across chunks",
  );
  for (const c of chunks) assert.ok(c.startsWith("Long Article: "));
  for (const c of wordCounts) assert.ok(c <= 350, "no chunk exceeds the hard cap");
});

test("chunkArticle: a single over-cap paragraph is kept whole (no mid-paragraph split)", () => {
  const bigPara = makePara("w", 500); // one paragraph, no paragraph boundary to split on
  const chunks = chunkArticle(bigPara, "T");
  assert.equal(chunks.length, 1);
  assert.equal(words(chunks[0].slice("T: ".length)).length, 500);
});

test("chunkArticle: hard cap forces an early close instead of overshooting", () => {
  // chunk1 never reaches the 280-word target alone (180w); next para is 200 words —
  // 180 + 200 = 380 > 350 hard cap, so chunk1 closes at 180 before the 200-word para starts chunk2.
  const md = [makePara("a", 180), makePara("b", 200)].join("\n\n");
  const chunks = chunkArticle(md, "T");
  const wordCounts = chunks.map((c) => words(c.slice("T: ".length)).length);
  assert.deepEqual(wordCounts, [180, 200]);
});

test("chunkArticle: tiny trailing chunk merges into the previous one", () => {
  // para1 (300w) closes immediately as its own chunk (>= 280-word target, single para).
  // para2 (20w) is left as a lone trailing chunk below the tiny-merge minimum (40w) ->
  // merges into chunk1 instead of shipping as a near-empty vector.
  const md = [makePara("a", 300), makePara("b", 20)].join("\n\n");
  const chunks = chunkArticle(md, "T");
  assert.equal(chunks.length, 1, "tiny trailing chunk should have merged, not stayed separate");
  assert.equal(words(chunks[0].slice("T: ".length)).length, 320);
});

test("chunkArticle: tiny NON-trailing orphan chunk merges into its previous neighbor", () => {
  // para A (300w) closes alone as chunk1 (>= 280-word target).
  // para B (10w) starts chunk2's buffer; para C (341w) would push chunk2 to 351w > the
  // 350 hard cap, so chunk2 closes EARLY at just 10 words — a tiny chunk stuck in the
  // MIDDLE (not last), which the old trailing-only merge rule could never catch.
  // para C (341w) then closes alone as chunk3 (>= 280-word target).
  // Pre-merge chunks would be [300, 10, 341]; the 10-word orphan (< the 40-word minimum)
  // must fold into its previous neighbor (chunk1), leaving [310, 341].
  const md = [makePara("a", 300), makePara("b", 10), makePara("c", 341)].join("\n\n");
  const chunks = chunkArticle(md, "T");
  const wordCounts = chunks.map((c) => words(c.slice("T: ".length)).length);
  assert.deepEqual(chunks.length, 2, `expected the orphan to merge into chunk1, got ${chunks.length} chunks`);
  assert.deepEqual(wordCounts, [310, 341]);
  assert.equal(
    wordCounts.reduce((a, b) => a + b, 0),
    651,
    "no words lost or duplicated across the merge",
  );
});

test("chunkArticle: no title -> no dangling prefix", () => {
  const chunks = chunkArticle(makePara("word", 10), "");
  assert.equal(chunks.length, 1);
  assert.ok(!chunks[0].startsWith(": "), "empty title should not leave a bare colon prefix");
});

// ---- searchText: post.urls -> registrable domains only (Task 5) ----------

test("searchText: post.urls collapse to bare domain, www. stripped", () => {
  const post = {
    id: "u1",
    text: "hello",
    author: { name: "a", screenName: "b" },
    urls: ["https://github.com/foo/bar", "https://www.example.com/path?q=1"],
  };
  const text = searchText(post);
  assert.ok(text.includes("github.com"), "bare github.com domain should appear");
  assert.ok(!text.includes("/foo/bar"), "URL path should not survive");
  assert.ok(text.includes("example.com"), "www. should be stripped down to the bare domain");
  assert.ok(!text.includes("www.example.com"), "www. prefix should not survive");
});

test("searchText: internal x.com/twitter.com links are dropped entirely", () => {
  const post = {
    id: "u2",
    text: "hello",
    author: { name: "a", screenName: "b" },
    urls: ["http://x.com/i/article/123", "https://www.twitter.com/someone/status/456"],
  };
  const text = searchText(post);
  assert.ok(!text.includes("x.com"), "x.com should be dropped, not just its path");
  assert.ok(!text.includes("twitter.com"), "twitter.com should be dropped, not just its path");
});

test("searchText: malformed URL is dropped without throwing", () => {
  const post = {
    id: "u3",
    text: "hello",
    author: { name: "a", screenName: "b" },
    urls: ["not a url", "https://github.com/foo"],
  };
  assert.doesNotThrow(() => searchText(post));
  const text = searchText(post);
  assert.ok(text.includes("github.com"), "well-formed URL alongside a malformed one should still map");
  assert.ok(!text.includes("not a url"), "malformed URL should not survive verbatim");
});

test("searchText: duplicate domains across multiple post.urls are deduped", () => {
  const post = {
    id: "u4",
    text: "hello",
    author: { name: "a", screenName: "b" },
    urls: ["https://github.com/foo/bar", "https://github.com/baz/qux"],
  };
  const text = searchText(post);
  const occurrences = text.split("github.com").length - 1;
  assert.equal(occurrences, 1, "github.com should appear exactly once despite two urls on that domain");
});

// ---- 5. embedItemsForPost (bonus smoke coverage) -------------------------

test("embedItemsForPost: main-only post -> single v1-compatible item, no `part`", () => {
  const post = { id: "1", text: "hello world", author: { name: "a", screenName: "b" } };
  const items = embedItemsForPost(post);
  assert.equal(items.length, 1);
  assert.equal("part" in items[0], false);
  assert.ok(items[0].text.startsWith("passage: "));
});

test("embedItemsForPost: article post -> main item + numbered chunk items", () => {
  const post = {
    id: "2",
    text: "hello world",
    author: { name: "a", screenName: "b" },
    articleTitle: "Big Piece",
    articleText: Array.from({ length: 5 }, (_, i) => makePara(`p${i}`, 100)).join("\n\n"), // 500 words -> 300,200
  };
  const items = embedItemsForPost(post);
  assert.ok(items.length > 1, "article post should produce chunk items beyond the main vector");
  assert.equal("part" in items[0], false, "first item is still the v1-compatible main vector");
  const chunkItems = items.slice(1);
  assert.deepEqual(
    chunkItems.map((it) => it.part),
    chunkItems.map((_, i) => i + 1),
    "part numbers start at 1 and are sequential",
  );
  for (const it of chunkItems) assert.ok(it.text.startsWith("passage: Big Piece: "));
});

// ---- 2. grouping identity on v1-shaped items -----------------------------

function dot(a, b) {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
  return total;
}

const v1Index = {
  items: [
    { id: "a", embedding: [1, 0, 0, 0] },
    { id: "b", embedding: [0, 1, 0, 0] },
    { id: "c", embedding: [0, 0, 1, 0] },
  ],
};

test("vectorSearch: v1 index (one item per id) is the identity — plain dot product per id", () => {
  const q = [0.5, 0.2, 0.9, 0];
  const results = vectorSearch(v1Index, q);
  const byId = Object.fromEntries(results.map((r) => [r.id, r.score]));
  assert.equal(results.length, 3);
  assert.equal(byId.a, dot(q, [1, 0, 0, 0]));
  assert.equal(byId.b, dot(q, [0, 1, 0, 0]));
  assert.equal(byId.c, dot(q, [0, 0, 1, 0]));
  // sorted desc
  for (let i = 1; i < results.length; i += 1) assert.ok(results[i - 1].score >= results[i].score);
});

test("multiVectorSearch: v1 index reproduces the pre-grouping best*0.8+avg*0.2 formula exactly", () => {
  const queries = [
    [1, 0, 0, 0],
    [0, 1, 1, 0],
  ];
  const results = multiVectorSearch(v1Index, queries);
  const byId = Object.fromEntries(results.map((r) => [r.id, r.score]));

  for (const item of v1Index.items) {
    const scores = queries.map((q) => dot(q, item.embedding));
    const best = Math.max(...scores);
    const avg = scores.reduce((s, v) => s + v, 0) / scores.length;
    assert.ok(
      Math.abs(byId[item.id] - (best * 0.8 + avg * 0.2)) < 1e-12,
      `id ${item.id}: expected ${best * 0.8 + avg * 0.2}, got ${byId[item.id]}`,
    );
  }
});

// ---- 3. max-pool correctness on synthetic multi-part items ---------------

const multiPartIndex = {
  items: [
    { id: "a", embedding: [0.1, 0, 0, 0] }, // main vector: weak match
    { id: "a", part: 1, embedding: [1, 0, 0, 0] }, // chunk: strong match
    { id: "a", part: 2, embedding: [0.2, 0, 0, 0] }, // chunk: weak match
    { id: "b", embedding: [0.9, 0.1, 0, 0] }, // main only
  ],
};

test("vectorSearch: max-pools per id across main + chunk items (chunk can win over main)", () => {
  const q = [1, 0, 0, 0];
  const results = vectorSearch(multiPartIndex, q);
  assert.equal(results.length, 2, "one entry per id, not one per item");
  const byId = Object.fromEntries(results.map((r) => [r.id, r.score]));
  assert.equal(byId.a, 1, "id a's score should be its strongest chunk (part 1), not its main vector");
  assert.equal(byId.b, dot(q, [0.9, 0.1, 0, 0]));
  assert.equal(results[0].id, "a", "the chunk-boosted id should outrank the main-only id");
});

test("multiVectorSearch: per-query max-pool happens before the best*0.8+avg*0.2 cross-query combine", () => {
  const queries = [
    [1, 0, 0, 0], // id a's part-1 chunk wins this query (score 1)
    [0, 1, 0, 0], // id a's best item here is the main vector (score 0); id b scores 0.1
  ];
  const results = multiVectorSearch(multiPartIndex, queries);
  const byId = Object.fromEntries(results.map((r) => [r.id, r.score]));
  assert.equal(results.length, 2);

  // id a: per-query max-pooled scores are [1 (chunk part1), 0 (all items score 0 on q2)]
  const aExpected = 1 * 0.8 + ((1 + 0) / 2) * 0.2;
  assert.ok(Math.abs(byId.a - aExpected) < 1e-12);

  // id b: only one item, scores are [0.9, 0.1]
  const bExpected = 0.9 * 0.8 + ((0.9 + 0.1) / 2) * 0.2;
  assert.ok(Math.abs(byId.b - bExpected) < 1e-12);
});

// ---- 4. RRF feeds one entry per id ----------------------------------------

test("mergeHybridResults: RRF output has exactly one entry per id (no double-counting multi-part hits)", () => {
  const q = [1, 0, 0, 0];
  const vectorResults = vectorSearch(multiPartIndex, q); // already grouped: 2 entries (a, b)
  const keywordResults = [
    { id: "a", score: 5 },
    { id: "b", score: 3 },
  ];
  const merged = mergeHybridResults(keywordResults, vectorResults, "broad");
  const ids = merged.map((r) => r.id);
  assert.equal(ids.length, new Set(ids).size, "no id should appear twice in the merged ranking");
  assert.equal(merged.length, 2, "id a's 3 underlying vectors must not inflate its RRF weight");
});

// ---- buildKeywordIndex: article + quoted field parity (Task 7) -----------

test("buildKeywordIndex: a phrase only present in articleText is findable via the `article` field", () => {
  const posts = [
    {
      id: "art1",
      text: "unrelated tweet body",
      author: { name: "a", screenName: "b" },
      articleTitle: "Some Article",
      articleText: "This is the lead paragraph. It contains a distinctive phrase xylophone quokka marmalade in it.",
    },
    { id: "art2", text: "a completely different post about something else", author: { name: "c", screenName: "d" } },
  ];
  const index = buildKeywordIndex(posts);
  const results = keywordSearch(index, "xylophone quokka marmalade");
  assert.ok(
    results.some((r) => r.id === "art1"),
    "post with the phrase in articleText should be retrievable by keyword search",
  );
});

test("buildKeywordIndex: articleText is truncated to the first ARTICLE_INDEX_CHAR_LIMIT (2000) chars", () => {
  const farPastLimit = "z".repeat(2000) + " needle beyond the twothousand char cutoff marker";
  const posts = [
    {
      id: "trunc1",
      text: "unrelated",
      author: { name: "a", screenName: "b" },
      articleTitle: "T",
      articleText: farPastLimit,
    },
  ];
  const index = buildKeywordIndex(posts);
  const results = keywordSearch(index, "twothousand");
  assert.equal(results.length, 0, "text past the 2000-char truncation boundary should not be indexed");
});

test("buildKeywordIndex: a phrase only present in quotedTweet.text is findable via the `quoted` field", () => {
  const posts = [
    {
      id: "q1",
      text: "unrelated tweet body",
      author: { name: "a", screenName: "b" },
      quotedTweet: {
        text: "a quoted phrase about kumquat basilisk trampoline",
        author: { name: "Quoter Name", screenName: "quoterhandle" },
      },
    },
    { id: "q2", text: "a completely different post about something else", author: { name: "c", screenName: "d" } },
  ];
  const index = buildKeywordIndex(posts);
  const results = keywordSearch(index, "kumquat basilisk trampoline");
  assert.ok(
    results.some((r) => r.id === "q1"),
    "post with the phrase in quotedTweet.text should be retrievable by keyword search",
  );
});

test("buildKeywordIndex: posts without articleText/quotedTweet build without throwing (nullish guards)", () => {
  const posts = [{ id: "bare1", text: "just a plain tweet", author: { name: "a", screenName: "b" } }];
  assert.doesNotThrow(() => buildKeywordIndex(posts));
});

// ---- applyAbsoluteVectorFloor (Task 6 / T1.3) ------------------------------

test("applyAbsoluteVectorFloor: scale-aware — cosine floor is compared against dot * 127, not the raw cosine", () => {
  // int8-quantized item vectors score ~127*cosine on a matching query; a 0.80 cosine
  // floor must therefore be applied as raw_score >= 0.80*127 = 101.6, not raw_score >= 0.80.
  const results = [
    { id: "above", score: 110 }, // 110/127 = 0.866 -> passes a 0.80 floor
    { id: "just-above", score: 102 }, // 102/127 = 0.803 -> passes a 0.80 floor
    { id: "below", score: 100 }, // 100/127 = 0.787 -> fails a 0.80 floor
  ];
  const filtered = applyAbsoluteVectorFloor(results, 0.8);
  const ids = filtered.map((r) => r.id);
  assert.deepEqual(ids, ["above", "just-above"], "only items with raw score >= cosineFloor*127 should survive");
});

test("applyAbsoluteVectorFloor: falsy/zero/negative cosineFloor is a no-op (v1 index / disabled-floor path)", () => {
  const results = [
    { id: "a", score: 5 },
    { id: "b", score: -3 },
  ];
  assert.deepEqual(applyAbsoluteVectorFloor(results, 0), results, "0 (falsy) floor should not filter anything");
  assert.deepEqual(applyAbsoluteVectorFloor(results, -1), results, "negative floor should not filter anything");
  assert.deepEqual(applyAbsoluteVectorFloor(results, undefined), results, "undefined floor should not filter anything");
});

test("applyRelativeFloor: filters merged RRF scores to a fraction of the top score (broad-mode merged floor math)", () => {
  const merged = [
    { id: "top", score: 0.1 },
    { id: "mid", score: 0.05 }, // exactly 50% of top -> kept (>=)
    { id: "low", score: 0.04 }, // below 50% of top -> dropped
  ];
  const floored = applyRelativeFloor(merged, 0.5);
  assert.deepEqual(
    floored.map((r) => r.id),
    ["top", "mid"],
    "only entries scoring >= fraction * topScore should survive",
  );
});

test("applyRelativeFloor: minKeep guard keeps below-floor results within the first minKeep ranks (review-task6-quality-r1 F1)", () => {
  const results = [
    { id: "rank1", score: 1 },
    { id: "rank2", score: 0.01 }, // far below the 0.5 floor, but rank 2 of a minKeep=3 guard
    { id: "rank3", score: 0.01 }, // far below the 0.5 floor, but rank 3 of a minKeep=3 guard (last protected rank)
  ];
  const floored = applyRelativeFloor(results, 0.5, 3);
  assert.deepEqual(
    floored.map((r) => r.id),
    ["rank1", "rank2", "rank3"],
    "a below-floor result ranked within the first minKeep positions should survive",
  );
});

test("applyRelativeFloor: minKeep guard does not protect rank minKeep+1 — a below-floor result there is still dropped", () => {
  const results = [
    { id: "rank1", score: 1 },
    { id: "rank2", score: 0.01 },
    { id: "rank3", score: 0.01 },
    { id: "rank4", score: 0.01 }, // rank 4 = minKeep(3)+1, below floor, outside the guard -> dropped
  ];
  const floored = applyRelativeFloor(results, 0.5, 3);
  assert.deepEqual(
    floored.map((r) => r.id),
    ["rank1", "rank2", "rank3"],
    "a below-floor result at rank minKeep+1 should still be dropped by the floor",
  );
});

// ---- rerankResults / minMaxNormalize / buildRerankDocText (Task 11, T3.2) ------------

test("minMaxNormalize: scales a differentiated array to [0, 1]", () => {
  assert.deepEqual(minMaxNormalize([0, 5, 10]), [0, 0.5, 1]);
});

test("minMaxNormalize: ties (max === min) collapse to a neutral 0.5, not 0 or 1", () => {
  assert.deepEqual(minMaxNormalize([3, 3, 3]), [0.5, 0.5, 0.5]);
  assert.deepEqual(minMaxNormalize([7]), [0.5], "a single-element array is trivially a tie");
});

test("minMaxNormalize: empty array is a no-op", () => {
  assert.deepEqual(minMaxNormalize([]), []);
});

test("buildRerankDocText: assembles author prefix + text + articleTitle + first 300 chars of articleText + quoted text, whitespace-collapsed", () => {
  const post = {
    text: "hello   world",
    articleTitle: "My  Title",
    articleText: `${"x".repeat(310)} tail-beyond-300`,
    author: { name: "Guillermo Rauch", screenName: "rauchg" },
    quotedTweet: { text: "a\nquoted\ttweet" },
  };
  const docText = buildRerankDocText(post);
  assert.ok(!/\s{2,}/.test(docText), "no run of 2+ whitespace chars should survive collapsing");
  assert.ok(
    docText.startsWith("@rauchg (Guillermo Rauch): hello world My Title"),
    "fields should appear in authorPrefix, text, articleTitle, articleText, quoted order",
  );
  assert.ok(docText.includes("x".repeat(300)), "first 300 chars of articleText should be included");
  assert.ok(!docText.includes("tail-beyond-300"), "articleText past the 300-char excerpt cap should not appear");
  assert.ok(docText.includes("a quoted tweet"), "quoted tweet text should be included, newlines/tabs collapsed");
});

test("buildRerankDocText: author prefix omits the parenthesized name when only screenName is present", () => {
  const docText = buildRerankDocText({ text: "hi", author: { screenName: "rauchg" } });
  assert.equal(docText, "@rauchg: hi");
});

test("buildRerankDocText: caps the final assembled text at ~1000 chars", () => {
  const post = { text: "w ".repeat(2000) };
  const docText = buildRerankDocText(post);
  assert.ok(docText.length <= 1000, `expected length <= 1000, got ${docText.length}`);
});

test("buildRerankDocText: missing optional fields (no author, no article, no quoted tweet) does not throw or leave stray whitespace", () => {
  assert.doesNotThrow(() => buildRerankDocText({ text: "just a tweet" }));
  const docText = buildRerankDocText({ text: "just a tweet" });
  assert.equal(docText, "just a tweet");
});

const rerankHybrid = [
  { id: "a", score: 10 },
  { id: "b", score: 5 },
  { id: "c", score: 0 },
];

await testAsync("rerankResults: min-max normalizes both sides then blends 0.6*ce + 0.4*hybrid, re-sorting the window", async () => {
  // ceScoresRaw deliberately inverted vs. the incoming hybrid order: id "a" (hybrid rank 1)
  // gets the WORST ce score, id "c" (hybrid rank 3) gets the BEST ce score.
  const ceScoresRaw = [0.1, 0.5, 0.9]; // -> minMax -> [0, 0.5, 1] for a, b, c respectively
  // hybrid [10, 5, 0] -> minMax -> [1, 0.5, 0] for a, b, c respectively
  // blended: a = 0.6*0 + 0.4*1 = 0.4 | b = 0.6*0.5 + 0.4*0.5 = 0.5 | c = 0.6*1 + 0.4*0 = 0.6
  const seenDocTexts = [];
  const result = await rerankResults(
    "python programming",
    rerankHybrid,
    (id) => {
      seenDocTexts.push(id);
      return `doc for ${id}`;
    },
    50,
    async (query, docTexts) => {
      assert.equal(query, "python programming");
      assert.deepEqual(docTexts, ["doc for a", "doc for b", "doc for c"]);
      return ceScoresRaw;
    },
  );
  assert.deepEqual(result.map((r) => r.id), ["c", "b", "a"], "blend should re-sort the window by the new blended score");
  assert.ok(Math.abs(result[0].score - 0.6) < 1e-9, `expected c's blended score ~0.6, got ${result[0].score}`);
  assert.ok(Math.abs(result[1].score - 0.5) < 1e-9, `expected b's blended score ~0.5, got ${result[1].score}`);
  assert.ok(Math.abs(result[2].score - 0.4) < 1e-9, `expected a's blended score ~0.4, got ${result[2].score}`);
  assert.deepEqual(seenDocTexts, ["a", "b", "c"], "getDocText should be called once per windowed id, in order");
});

await testAsync("rerankResults: results beyond `limit` are an untouched tail — not scored, not reordered", async () => {
  const results = [
    { id: "a", score: 10 },
    { id: "b", score: 9 },
    { id: "c", score: 8 },
    { id: "d", score: 7 },
    { id: "e", score: 6 },
  ];
  const scoredIds = [];
  const result = await rerankResults(
    "query",
    results,
    (id) => {
      if (id === "c" || id === "d" || id === "e") {
        throw new Error(`getDocText should never be called for a tail id, got "${id}"`);
      }
      scoredIds.push(id);
      return `doc ${id}`;
    },
    2, // window = [a, b], tail = [c, d, e]
    async () => [0.1, 0.9], // a: ceNorm 0 (low), b: ceNorm 1 (high) -> flips the a>b hybrid order
  );
  assert.deepEqual(scoredIds, ["a", "b"], "only the windowed ids should reach getDocText/scoreFn");
  assert.deepEqual(
    result.slice(2),
    [
      { id: "c", score: 8 },
      { id: "d", score: 7 },
      { id: "e", score: 6 },
    ],
    "the tail beyond `limit` must survive byte-identical, in original order, with original scores",
  );
  assert.equal(result[0].id, "b", "the window itself should still be re-sorted by the blend");
});

await testAsync("rerankResults: silent-skip — a scorer that throws returns the input completely unchanged", async () => {
  const result = await rerankResults(
    "query",
    rerankHybrid,
    (id) => `doc ${id}`,
    50,
    async () => {
      throw new Error("simulated model-load failure");
    },
  );
  assert.deepEqual(result, rerankHybrid, "on scorer failure, output must be reference-equal-in-value to the original input");
});

await testAsync("rerankResults: silent-skip — a scorer returning the wrong number of scores is treated as a failure", async () => {
  const result = await rerankResults(
    "query",
    rerankHybrid,
    (id) => `doc ${id}`,
    50,
    async () => [0.9], // only 1 score for a 3-item window
  );
  assert.deepEqual(result, rerankHybrid, "a length-mismatched scorer result must fall back to the unchanged input");
});

await testAsync("rerankResults: silent-skip — a throwing getDocText also falls back to the unchanged input", async () => {
  const result = await rerankResults(
    "query",
    rerankHybrid,
    () => {
      throw new Error("simulated doc-text lookup failure");
    },
    50,
    async () => [0.1, 0.5, 0.9],
  );
  assert.deepEqual(result, rerankHybrid);
});

await testAsync("rerankResults: an empty/whitespace-only query short-circuits without calling the scorer", () => {
  let scorerCalled = false;
  return rerankResults(
    "   ",
    rerankHybrid,
    (id) => `doc ${id}`,
    50,
    async () => {
      scorerCalled = true;
      return [0.1, 0.5, 0.9];
    },
  ).then((result) => {
    assert.equal(scorerCalled, false, "scoreFn must not be invoked for a blank query");
    assert.deepEqual(result, rerankHybrid);
  });
});

await testAsync("rerankResults: fewer than 2 results short-circuits without calling the scorer", () => {
  let scorerCalled = false;
  return rerankResults(
    "query",
    [{ id: "only", score: 1 }],
    (id) => `doc ${id}`,
    50,
    async () => {
      scorerCalled = true;
      return [0.5];
    },
  ).then((result) => {
    assert.equal(scorerCalled, false, "scoreFn must not be invoked when there's nothing meaningful to reorder");
    assert.deepEqual(result, [{ id: "only", score: 1 }]);
  });
});

// ---- rerankResults coalescing scheduler (F1 fix, review-task11-quality-r1.md) --------
//
// A rerank call never starts scoring synchronously — it always parks first, then a
// deferred microtask promotes the sole parked task once nothing is in flight. That means
// two calls issued back-to-back with no intervening `await` also coalesce onto only the
// later one: the earlier one is superseded (resolves with its own input order, scorer
// never invoked) before it ever gets a chance to run.

await testAsync("rerankResults coalescing: two calls issued in the same tick — only the latest is scored, the superseded one resolves its own input order", async () => {
  const resultsA = [
    { id: "a1", score: 10 },
    { id: "a2", score: 5 },
  ];
  const resultsB = [
    { id: "b1", score: 3 },
    { id: "b2", score: 7 },
  ];
  let scorerACalled = false;
  const scoreFnA = async () => {
    scorerACalled = true;
    return [0.1, 0.9];
  };
  const scoreFnB = async (query, docTexts) => {
    assert.deepEqual(docTexts, ["doc b1", "doc b2"]);
    return [0.9, 0.1]; // flips b1/b2 vs. their hybrid order
  };

  // No `await` between these two — genuinely the same synchronous tick/microtask batch.
  const promiseA = rerankResults("query a", resultsA, (id) => `doc ${id}`, 50, scoreFnA);
  const promiseB = rerankResults("query b", resultsB, (id) => `doc ${id}`, 50, scoreFnB);

  const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

  assert.equal(scorerACalled, false, "the superseded call's scorer must never be invoked");
  assert.deepEqual(resultA, resultsA, "the superseded call resolves with its own input order, unchanged");
  assert.deepEqual(resultB.map((r) => r.id), ["b1", "b2"], "the latest call gets real cross-encoder ordering");
});

await testAsync("rerankResults coalescing: serial awaited calls are unaffected — each gets its own real scoring pass", async () => {
  const calls = [];
  const scoreFn = async (query, docTexts) => {
    calls.push(query);
    return docTexts.map(() => 0.5);
  };

  const first = await rerankResults("first", rerankHybrid, (id) => `doc ${id}`, 50, scoreFn);
  const second = await rerankResults("second", rerankHybrid, (id) => `doc ${id}`, 50, scoreFn);

  assert.deepEqual(calls, ["first", "second"], "both serial, awaited calls must invoke the scorer, in order");
  assert.equal(first.length, rerankHybrid.length);
  assert.equal(second.length, rerankHybrid.length);
});

await testAsync("rerankResults coalescing: a third call replaces a still-parked second call — the second resolves input order, the third is scored", async () => {
  const results1 = [
    { id: "x1", score: 10 },
    { id: "x2", score: 5 },
  ];
  const results2 = [
    { id: "y1", score: 4 },
    { id: "y2", score: 8 },
  ];
  const results3 = [
    { id: "z1", score: 1 },
    { id: "z2", score: 2 },
  ];

  let releaseScoreFn1;
  const scoreFn1Gate = new Promise((resolve) => {
    releaseScoreFn1 = resolve;
  });
  const scoreFn1 = async () => {
    await scoreFn1Gate;
    return [0.9, 0.1];
  };
  let scorer2Called = false;
  const scoreFn2 = async () => {
    scorer2Called = true;
    return [0.5, 0.5];
  };
  const scoreFn3 = async () => [0.1, 0.9]; // z2 has the higher hybrid AND ce score -> ranks first

  const promise1 = rerankResults("q1", results1, (id) => `doc ${id}`, 50, scoreFn1);
  // Let call 1's deferred kickoff microtask run so it is genuinely in flight (blocked on
  // scoreFn1Gate) before call 2 arrives.
  await Promise.resolve();

  const promise2 = rerankResults("q2", results2, (id) => `doc ${id}`, 50, scoreFn2);
  const promise3 = rerankResults("q3", results3, (id) => `doc ${id}`, 50, scoreFn3);

  releaseScoreFn1();
  const [result1, result2, result3] = await Promise.all([promise1, promise2, promise3]);

  assert.deepEqual(result1.map((r) => r.id), ["x1", "x2"], "call 1's real (in-flight) scoring pass completes normally");
  assert.equal(scorer2Called, false, "call 2's scorer must never run — it was superseded while still parked");
  assert.deepEqual(result2, results2, "the superseded parked call resolves with its own input order, unchanged");
  assert.deepEqual(result3.map((r) => r.id), ["z2", "z1"], "call 3 (the latest parked task) gets its own real scoring pass");
});

// ---- F2 drift guard (Task 3): builders must still match lib/*.ts source -------------

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readSrc(relPath) {
  return readFileSync(join(repoRoot, relPath), "utf8");
}

/**
 * Extract `this.field("name", { boost: N })` / bare `this.field("name");` declarations from
 * a buildKeywordIndex-shaped `lunr(function build() { ... for (const post of posts) ...})`
 * body. Returns `{ [fieldName]: boost | null }` (null = no boost option, i.e. default 1).
 */
function extractFieldBoosts(source) {
  const bodyMatch = source.match(/function build\(\)\s*\{([\s\S]*?)for \(const post of posts\)/);
  if (!bodyMatch) {
    throw new Error("extractFieldBoosts: could not locate buildKeywordIndex's lunr `build()` field declarations");
  }
  const boosts = {};
  const re = /this\.field\("([a-z]+)"(?:,\s*\{\s*boost:\s*(\d+)\s*\})?\)/g;
  let m;
  while ((m = re.exec(bodyMatch[1]))) {
    boosts[m[1]] = m[2] !== undefined ? Number(m[2]) : null;
  }
  return boosts;
}

function extractConst(source, name) {
  const m = source.match(new RegExp(`const ${name}\\s*=\\s*(\\d+)\\s*;`));
  if (!m) throw new Error(`extractConst: "${name}" not found in source`);
  return Number(m[1]);
}

test("F2 drift guard: buildKeywordIndex field/boost config matches between lib/bookmark-search.ts and search-core.mjs", () => {
  const tsBoosts = extractFieldBoosts(readSrc("lib/bookmark-search.ts"));
  const mjsBoosts = extractFieldBoosts(readSrc("scripts/lib/search-core.mjs"));
  assert.deepEqual(
    mjsBoosts,
    tsBoosts,
    "scripts/lib/search-core.mjs's buildKeywordIndex field/boost config has drifted from lib/bookmark-search.ts (the source of truth the client and the Worker's lunr-index.json must both match) — update search-core.mjs to match",
  );
  // Pin the values too, so a coordinated-but-wrong edit of BOTH files still fails loudly.
  assert.deepEqual(tsBoosts, { text: 4, title: 5, author: 2, url: null, article: 3, quoted: 2, thread: 2 });
});

test("F2 drift guard: ARTICLE_INDEX_CHAR_LIMIT matches between lib/bookmark-search.ts and search-core.mjs", () => {
  const tsLimit = extractConst(readSrc("lib/bookmark-search.ts"), "ARTICLE_INDEX_CHAR_LIMIT");
  const mjsLimit = extractConst(readSrc("scripts/lib/search-core.mjs"), "ARTICLE_INDEX_CHAR_LIMIT");
  assert.equal(mjsLimit, tsLimit, "search-core.mjs's ARTICLE_INDEX_CHAR_LIMIT has drifted from lib/bookmark-search.ts");
  assert.equal(tsLimit, 2000);
});

test("F2 drift guard: rerank doc-text char caps match between lib/rerank.ts and search-core.mjs", () => {
  const tsSrc = readSrc("lib/rerank.ts");
  const mjsSrc = readSrc("scripts/lib/search-core.mjs");
  const tsExcerpt = extractConst(tsSrc, "ARTICLE_EXCERPT_CHARS");
  const mjsExcerpt = extractConst(mjsSrc, "ARTICLE_EXCERPT_CHARS");
  const tsCap = extractConst(tsSrc, "DOC_TEXT_CHAR_CAP");
  const mjsCap = extractConst(mjsSrc, "DOC_TEXT_CHAR_CAP");
  assert.equal(mjsExcerpt, tsExcerpt, "search-core.mjs's ARTICLE_EXCERPT_CHARS has drifted from lib/rerank.ts");
  assert.equal(mjsCap, tsCap, "search-core.mjs's DOC_TEXT_CHAR_CAP has drifted from lib/rerank.ts");
  assert.equal(tsExcerpt, 300);
  assert.equal(tsCap, 1000);
});

test("F2 drift guard: THREAD_EXCERPT_CHARS (rerank thread excerpt) matches between lib/rerank.ts and search-core.mjs", () => {
  const ts = extractConst(readSrc("lib/rerank.ts"), "THREAD_EXCERPT_CHARS");
  const mjs = extractConst(readSrc("scripts/lib/search-core.mjs"), "THREAD_EXCERPT_CHARS");
  assert.equal(mjs, ts, "search-core.mjs's THREAD_EXCERPT_CHARS has drifted from lib/rerank.ts");
  assert.equal(ts, 300);
});

test("threadText: one paragraph per thread post, t.co links stripped, empty without a thread", () => {
  assert.equal(threadText({}), "");
  assert.equal(
    threadText({ thread: [{ text: "2/3 more detail https://t.co/abc123" }, { text: "" }, { text: "3/3 the end" }] }),
    "2/3 more detail\n\n3/3 the end",
  );
});

test("F2 drift guard: build-lunr-index.mjs / build-rerank-docs.mjs import from search-core.mjs instead of hand-copying", () => {
  const lunrBuilderSrc = readSrc("scripts/build-lunr-index.mjs");
  const rerankBuilderSrc = readSrc("scripts/build-rerank-docs.mjs");

  assert.match(
    lunrBuilderSrc,
    /from\s+["']\.\/lib\/search-core\.mjs["']/,
    "build-lunr-index.mjs no longer imports from ./lib/search-core.mjs",
  );
  assert.doesNotMatch(
    lunrBuilderSrc,
    /function\s+buildKeywordIndex\s*\(/,
    "build-lunr-index.mjs re-declares buildKeywordIndex locally — the exact F2 hand-copy drift risk; import it from ./lib/search-core.mjs instead",
  );

  assert.match(
    rerankBuilderSrc,
    /from\s+["']\.\/lib\/search-core\.mjs["']/,
    "build-rerank-docs.mjs no longer imports from ./lib/search-core.mjs",
  );
  // A thin local wrapper (surrogate-stripping around the imported core fn) is fine and
  // expected — see that file's doc comment; what F2 actually guards against is the config
  // itself (the excerpt/cap constants) being hand-copied a second time instead of living
  // solely in search-core.mjs.
  assert.doesNotMatch(
    rerankBuilderSrc,
    /const\s+(ARTICLE_EXCERPT_CHARS|DOC_TEXT_CHAR_CAP)\s*=/,
    "build-rerank-docs.mjs re-declares ARTICLE_EXCERPT_CHARS/DOC_TEXT_CHAR_CAP locally — the exact F2 hand-copy drift risk; those constants must live only in ./lib/search-core.mjs",
  );
  assert.match(
    rerankBuilderSrc,
    /buildRerankDocTextCore/,
    "build-rerank-docs.mjs no longer delegates to the imported buildRerankDocText from ./lib/search-core.mjs",
  );
});

test("F2 drift guard: buildRerankDocText output respects the char caps extracted live from lib/rerank.ts", () => {
  const excerptChars = extractConst(readSrc("lib/rerank.ts"), "ARTICLE_EXCERPT_CHARS");
  const capChars = extractConst(readSrc("lib/rerank.ts"), "DOC_TEXT_CHAR_CAP");

  const post = {
    text: "T".repeat(50),
    author: { name: "Author Name", screenName: "handle" },
    articleTitle: "Title",
    articleText: "A".repeat(excerptChars + 500), // exceeds the excerpt cap
    quotedTweet: { text: "Q".repeat(50) },
  };
  const docText = buildRerankDocText(post);
  assert.ok(docText.length <= capChars, `doc text (${docText.length} chars) exceeds DOC_TEXT_CHAR_CAP (${capChars})`);
  assert.ok(
    !docText.includes("A".repeat(excerptChars + 1)),
    "articleText should be truncated to ARTICLE_EXCERPT_CHARS before the overall doc-text cap",
  );
});

// ---- summary ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
