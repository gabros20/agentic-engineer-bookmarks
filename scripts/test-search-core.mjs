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

import assert from "node:assert/strict";
import { chunkArticle, embedItemsForPost, searchText } from "./lib/embed.mjs";
import {
  applyAbsoluteVectorFloor,
  applyRelativeFloor,
  buildKeywordIndex,
  keywordSearch,
  mergeHybridResults,
  multiVectorSearch,
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

// ---- summary ---------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
