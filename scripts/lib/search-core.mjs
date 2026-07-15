// Node port of lib/bookmark-search.ts — keep in sync (drift is measured by eval, unified later).
//
// Faithful copy of the retrieval logic (keyword index, query expansion, multi-vector
// search, hybrid merge, relative floor, and the runHybridPipeline wiring function) so
// scripts/eval-search.mjs can run the exact production pipeline over the real data in
// plain Node, without a browser/React runtime. Constants below are copied VERBATIM from
// lib/bookmark-search.ts.

import lunr from "lunr";
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";

export const HYBRID_WEIGHTS = {
  exact: { keyword: 0.6, vector: 0.4 },
  broad: { keyword: 0.35, vector: 0.65 },
};

export const QUERY_EXPANSIONS = {
  ai: ["artificial intelligence", "llm", "large language model", "neural network", "machine learning", "model"],
  agent: ["agents", "agentic", "automation", "autonomous", "assistant", "workflow", "tool use"],
  agents: ["agent", "agentic", "automation", "autonomous", "assistants", "workflow", "tool use"],
  claude: ["claude code", "anthropic", "coding agent", "ai coding assistant"],
  codex: ["openai codex", "coding agent", "ai coding assistant", "code assistant"],
  code: ["coding", "programming", "developer", "software engineering", "repo", "repository"],
  context: ["memory", "knowledge", "prompt", "instructions", "prompt engineering", "rag"],
  learn: ["learning", "tutorial", "guide", "course", "education", "teach", "study", "explain"],
  memory: ["context", "knowledge graph", "persistence", "recall", "rag", "notes", "knowledge base"],
  prompt: ["prompts", "prompting", "prompt engineering", "instructions", "context", "system prompt"],
  prompts: ["prompt", "prompting", "prompt engineering", "instructions", "context", "system prompt"],
  search: ["retrieval", "semantic search", "vector search", "hybrid search", "rag", "index"],
  tool: ["tools", "cli", "mcp", "extension", "workflow", "automation"],
  tools: ["tool", "cli", "mcp", "extensions", "workflow", "automation"],
};

export function searchText(post) {
  return [
    post.text,
    post.articleTitle,
    post.articleText,
    post.author.name,
    post.author.screenName,
    ...(post.urls ?? []),
    post.quotedTweet?.text,
    post.quotedTweet?.author?.name,
    post.quotedTweet?.author?.screenName,
  ]
    .filter(Boolean)
    .join("\n");
}

// Cap the article body fed into lunr: article bodies are median ~1.7k WORDS, and lunr
// indexes at build time in the browser on ~5,370 posts per page load — indexing full
// bodies would blow up index build time/memory. 2,000 chars keeps that sane while still
// covering the lead of the article (where distinctive phrasing tends to live).
const ARTICLE_INDEX_CHAR_LIMIT = 2000;

export function buildKeywordIndex(posts) {
  return lunr(function build() {
    this.ref("id");
    this.field("text", { boost: 4 });
    this.field("title", { boost: 5 });
    this.field("author", { boost: 2 });
    this.field("url");
    this.field("article", { boost: 3 });
    this.field("quoted", { boost: 2 });

    for (const post of posts) {
      this.add({
        id: post.id,
        text: post.text,
        title: post.articleTitle ?? "",
        author: `${post.author.name} ${post.author.screenName}`,
        url: (post.urls ?? []).join(" "),
        article: (post.articleText ?? "").slice(0, ARTICLE_INDEX_CHAR_LIMIT),
        quoted: [post.quotedTweet?.text, post.quotedTweet?.author?.name, post.quotedTweet?.author?.screenName]
          .filter(Boolean)
          .join(" "),
      });
    }
  });
}

export function keywordSearch(index, query) {
  const terms = queryTerms(query);
  if (!terms.length) return [];

  try {
    return index
      .query((builder) => {
        builder.term(terms, {
          boost: 2,
          presence: lunr.Query.presence.OPTIONAL,
          wildcard: lunr.Query.wildcard.TRAILING,
        });
        builder.term(terms, {
          boost: 1,
          editDistance: 1,
          presence: lunr.Query.presence.OPTIONAL,
        });
      })
      .map((result) => ({
        id: result.ref,
        score: result.score,
      }));
  } catch {
    return index.search(terms.map((token) => `${token}~1`).join(" ")).map((result) => ({
      id: result.ref,
      score: result.score,
    }));
  }
}

/**
 * Score every item (main vector + any article-chunk vectors) against a single query
 * embedding, then group by bookmark id keeping the MAX score per id — one entry per id
 * in the output. With a v1 index (one item per id, no `part`) this is structurally the
 * identity: max of a single value is that value.
 */
function scorePerIdMax(items, queryEmbedding) {
  const byId = new Map();
  for (const item of items) {
    const score = dotProduct(queryEmbedding, item.embedding);
    const prev = byId.get(item.id);
    if (prev === undefined || score > prev) byId.set(item.id, score);
  }
  return byId;
}

export function vectorSearch(index, queryEmbedding) {
  return [...scorePerIdMax(index.items, queryEmbedding).entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export function multiVectorSearch(index, queryEmbeddings) {
  if (!queryEmbeddings.length) return [];

  // Per query embedding: max-pool per id across items (main + chunks) first, so a
  // multi-part bookmark contributes one score per query, not one per vector.
  const perQueryScores = queryEmbeddings.map((embedding) => scorePerIdMax(index.items, embedding));

  const ids = new Set(index.items.map((item) => item.id));
  const results = [];

  for (const id of ids) {
    let best = Number.NEGATIVE_INFINITY;
    let average = 0;

    for (const scores of perQueryScores) {
      // Invariant: `ids` is built from `index.items`, and `scorePerIdMax` scores every
      // item in `index.items` for every query embedding — so `id` is always present in
      // every per-query map. If that ever stops holding (e.g. a future top-k prune inside
      // scorePerIdMax), fail loudly rather than silently blending in -Infinity.
      if (!scores.has(id)) throw new Error(`multiVectorSearch: id "${id}" missing from a per-query score map`);
      const score = scores.get(id);
      best = Math.max(best, score);
      average += score;
    }

    results.push({ id, score: best * 0.8 + (average / perQueryScores.length) * 0.2 });
  }

  return results.sort((a, b) => b.score - a.score);
}

export function mergeHybridResults(keywordResults, vectorResults, precision = "broad") {
  const { keyword, vector } = HYBRID_WEIGHTS[precision];
  const scores = new Map();
  addReciprocalRanks(scores, keywordResults, keyword);
  addReciprocalRanks(scores, vectorResults, vector);

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export function expandSemanticQueries(query, precision = "broad") {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (precision === "exact") return normalized ? [normalized] : [];

  const terms = queryTerms(normalized);
  const expansions = new Set([normalized]);
  const expandedTerms = terms.flatMap((term) => QUERY_EXPANSIONS[term] ?? []);

  if (expandedTerms.length) {
    expansions.add(`${normalized} ${expandedTerms.join(" ")}`);
  }

  for (const term of terms) {
    const synonyms = QUERY_EXPANSIONS[term];
    if (synonyms?.length) {
      expansions.add(`${term} ${synonyms.join(" ")}`);
    }
  }

  return [...expansions].filter(Boolean).slice(0, 8);
}

/**
 * Filter merged RRF results to those scoring >= fraction * topScore. `minKeep` (default 0,
 * i.e. current/prior behavior) always keeps results ranked before that index regardless of
 * the floor — see BROAD_FLOOR_MIN_KEEP below for why (review-task6-quality-r1 F1).
 */
export function applyRelativeFloor(results, fraction, minKeep = 0) {
  if (!results.length || fraction <= 0) return results;
  const top = results[0].score;
  if (top <= 0) return results;
  const floor = top * fraction;
  return results.filter((r, i) => i < minKeep || r.score >= floor);
}

// Item embeddings on disk are int8-quantized (scripts/lib/embed.mjs `quantizeToInt8`):
// a normalized float32 vector scaled by 127 and rounded. Query embeddings stay float32
// normalized. So `dot(queryFloat, itemInt8) ≈ 127 * cosine(query, item)`. This constant
// converts a cosine-similarity floor into the raw dot-product scale that
// scorePerIdMax/vectorSearch/multiVectorSearch actually produce, so callers can reason
// in cosine terms (0..1) while filtering raw scores. Verified empirically in
// scripts/calibrate-floors.mjs (raw dot / 127 lands in the expected cosine range).
const INT8_VECTOR_SCALE = 127;

/**
 * Broad-mode relevance floors, calibrated by scripts/calibrate-floors.mjs on 2026-07-15
 * against the e5 v2 index (multilingual-e5-small, prefix_scheme "e5", chunked +
 * max-pooled per Task 4), see docs/SEARCH-UPGRADE-PLAN.md T1.3.
 *
 * BROAD_VECTOR_COSINE_FLOOR is applied to POOLED per-id vector scores (post max-pool
 * grouping, pre-900-slice) via applyAbsoluteVectorFloor. BROAD_MERGED_RELATIVE_FLOOR is
 * applied to merged RRF scores via applyRelativeFloor. Both apply ONLY when the loaded
 * index has prefix_scheme === "e5" — cosine distributions are model-specific, so a v1
 * (MiniLM) index must see unchanged (unfloored) behavior. Exact mode is untouched by
 * either constant; it keeps its own hardcoded 0.5 relative floor.
 */
export const BROAD_VECTOR_COSINE_FLOOR = 0.82;
export const BROAD_MERGED_RELATIVE_FLOOR = 0.5;

/**
 * Structural guard against RRF-relative-floor false negatives (review-task6-quality-r1
 * F1): an item ranking #1 in keyword but absent from the vector list (filtered out by
 * BROAD_VECTOR_COSINE_FLOOR) can score as low as ~0.35x the top merged RRF score, which is
 * below BROAD_MERGED_RELATIVE_FLOOR (0.5) — a legitimate top-rank keyword-only hit would
 * get dropped entirely. Always keeping the first 10 merged ranks regardless of the floor
 * closes that gap while leaving the floor's tail-shrinking behavior intact elsewhere.
 */
export const BROAD_FLOOR_MIN_KEEP = 10;

/**
 * Filter pooled per-id vector results (the output of vectorSearch/multiVectorSearch) to
 * those whose cosine similarity to the query is >= cosineFloor. Scale-aware: item
 * embeddings are int8-quantized, so the raw score is compared against
 * `cosineFloor * INT8_VECTOR_SCALE`, not against cosineFloor directly (see
 * INT8_VECTOR_SCALE above). A falsy/non-positive cosineFloor is a no-op.
 */
export function applyAbsoluteVectorFloor(results, cosineFloor) {
  if (!cosineFloor || cosineFloor <= 0) return results;
  const floor = cosineFloor * INT8_VECTOR_SCALE;
  return results.filter((r) => r.score >= floor);
}

/**
 * Runs the full hybrid pipeline: absolute vector floor (broad mode, e5 index only) ->
 * slice(0,900) -> RRF merge -> relative floor. Node port of lib/bookmark-search.ts's
 * runHybridPipeline, used directly by scripts/eval-search.mjs's runQuery so the eval
 * harness runs the identical pipeline as the client (review-task6-quality-r1 F2). Broad
 * mode's relative floor applies BROAD_FLOOR_MIN_KEEP (review-task6-quality-r1 F1); exact
 * mode keeps its existing hardcoded 0.5 relative floor untouched, no minKeep.
 */
export function runHybridPipeline(keywordResults, pooledVectorResults, precision, index) {
  const floorsActive = index.prefix_scheme === "e5";
  const vectorResults = (
    precision === "broad" && floorsActive
      ? applyAbsoluteVectorFloor(pooledVectorResults, BROAD_VECTOR_COSINE_FLOOR)
      : pooledVectorResults
  ).slice(0, 900);
  const merged = mergeHybridResults(keywordResults, vectorResults, precision);
  if (precision === "exact") return applyRelativeFloor(merged, 0.5);
  return floorsActive ? applyRelativeFloor(merged, BROAD_MERGED_RELATIVE_FLOOR, BROAD_FLOOR_MIN_KEEP) : merged;
}

function addReciprocalRanks(scores, results, weight) {
  const k = 60;
  for (const [index, result] of results.entries()) {
    scores.set(result.id, (scores.get(result.id) ?? 0) + weight / (k + index + 1));
  }
}

function queryTerms(query) {
  return lunr.tokenizer(query).map((token) => String(token)).filter(Boolean);
}

function dotProduct(a, b) {
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return total;
}

// ---- Task 11 (T3.2): cross-encoder rerank — Node port of lib/rerank.ts ----------------
//
// Node-side loader for the cross-encoder, so scripts/eval-search.mjs's scorecard measures
// the same shipping behavior as the browser. Uses AutoTokenizer + AutoModelForSequence-
// Classification directly (not `pipeline("text-classification", ...)`, which does not
// forward `text_pair` — see the full API probe notes in lib/rerank.ts). `dtype: "q8"` is
// passed explicitly on this side too: this package's DEFAULT_DEVICE_DTYPE_MAPPING only
// defaults to "q8" on the "wasm" device, so Node (which does not select "wasm") would
// otherwise silently download the full ~90 MB fp32 onnx file instead of the ~23 MB
// quantized one the brief specifies, and score with a different model precision than the
// browser mirror.

export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
export const RERANK_WINDOW = 50;

const CE_BLEND_WEIGHT = 0.6;
const HYBRID_BLEND_WEIGHT = 0.4;
const ARTICLE_EXCERPT_CHARS = 300;
const DOC_TEXT_CHAR_CAP = 1000;

let rerankerPromise = null;

// Retry-on-failure contract (mirrors lib/rerank.ts's loadReranker / the existing
// extractorPromise pattern in components/bookmarks-app.tsx): a rejected promise must not
// stay memoized, or one transient load failure would permanently disable rerank for the
// rest of this process.
async function loadReranker() {
  rerankerPromise ??= (async () => {
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(RERANK_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: "q8" }),
    ]);
    return { tokenizer, model };
  })();
  try {
    return await rerankerPromise;
  } catch (err) {
    rerankerPromise = null;
    throw err;
  }
}

/** Idle/pre-loop warmup — loads (and memoizes) the cross-encoder without scoring anything. */
export async function warmupReranker() {
  try {
    await loadReranker();
  } catch {
    // Silent — rerankResults' own try/catch is the real gate; see lib/rerank.ts's
    // warmupReranker doc comment for why a failed warmup is not retried here.
  }
}

function sigmoid(logit) {
  return 1 / (1 + Math.exp(-logit));
}

/**
 * Default scorer: the real cross-encoder. Exposed separately (mirrors lib/rerank.ts's
 * `scoreWithCrossEncoder`) so scripts/test-search-core.mjs can inject a stub `scoreFn` into
 * `rerankResults` and exercise the blend math without loading the real model.
 */
export async function scoreWithCrossEncoder(query, docTexts) {
  const { tokenizer, model } = await loadReranker();
  const inputs = tokenizer(
    docTexts.map(() => query),
    { text_pair: docTexts, padding: true, truncation: true },
  );
  const output = await model(inputs);
  return Array.from(output.logits.data).map(sigmoid);
}

/**
 * Min-max normalize a score array into [0, 1]. Ties (max === min, including the
 * single-element and all-equal cases) collapse to a neutral 0.5 for every entry — see
 * lib/rerank.ts's minMaxNormalize doc comment for the rationale. Verbatim mirror.
 */
export function minMaxNormalize(values) {
  if (!values.length) return values;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-9) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * Doc text fed to the cross-encoder: post text + articleTitle + first
 * ARTICLE_EXCERPT_CHARS chars of articleText + quoted tweet text, whitespace-collapsed and
 * capped at DOC_TEXT_CHAR_CAP chars. Verbatim mirror of lib/rerank.ts's buildRerankDocText.
 */
export function buildRerankDocText(post) {
  const parts = [
    post.text,
    post.articleTitle,
    post.articleText ? post.articleText.slice(0, ARTICLE_EXCERPT_CHARS) : undefined,
    post.quotedTweet?.text,
  ].filter(Boolean);
  const collapsed = parts.join(" ").replace(/\s+/g, " ").trim();
  return collapsed.slice(0, DOC_TEXT_CHAR_CAP);
}

/**
 * Cross-encoder rerank of the top `limit` hybrid results. Verbatim mirror of
 * lib/rerank.ts's rerankResults: min-max normalizes BOTH the cross-encoder scores and the
 * incoming hybrid scores over the window, blends CE_BLEND_WEIGHT*ce + HYBRID_BLEND_WEIGHT*
 * hybrid, re-sorts the window, appends the untouched tail. Silent-skip on any failure
 * (model load, tokenization, inference, or a scoreFn length mismatch) — returns `results`
 * unchanged, logs once via console.debug, never throws.
 */
export async function rerankResults(query, results, getDocText, limit = RERANK_WINDOW, scoreFn = scoreWithCrossEncoder) {
  const trimmedQuery = (query ?? "").trim();
  if (!trimmedQuery || results.length < 2) return results;

  const window = results.slice(0, limit);
  const tail = results.slice(limit);

  try {
    const docTexts = window.map((r) => getDocText(r.id));
    const ceScoresRaw = await scoreFn(trimmedQuery, docTexts);
    if (!Array.isArray(ceScoresRaw) || ceScoresRaw.length !== window.length) {
      throw new Error(
        `rerank: scoreFn returned ${Array.isArray(ceScoresRaw) ? ceScoresRaw.length : typeof ceScoresRaw} scores for a window of ${window.length}`,
      );
    }

    const ceNorm = minMaxNormalize(ceScoresRaw);
    const hybridNorm = minMaxNormalize(window.map((r) => r.score));

    const blended = window
      .map((r, i) => ({ id: r.id, score: CE_BLEND_WEIGHT * ceNorm[i] + HYBRID_BLEND_WEIGHT * hybridNorm[i] }))
      .sort((a, b) => b.score - a.score);

    return [...blended, ...tail];
  } catch (err) {
    console.debug("[rerank] skipped:", err?.message ?? err);
    return results;
  }
}
