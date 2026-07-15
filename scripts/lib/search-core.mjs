// Node port of lib/bookmark-search.ts — keep in sync (drift is measured by eval, unified later).
//
// Faithful copy of the retrieval logic (keyword index, query expansion, multi-vector
// search, hybrid merge, relative floor) so scripts/eval-search.mjs can run the exact
// production pipeline over the real data in plain Node, without a browser/React runtime.
// Constants below are copied VERBATIM from lib/bookmark-search.ts.

import lunr from "lunr";

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

export function applyRelativeFloor(results, fraction) {
  if (!results.length || fraction <= 0) return results;
  const top = results[0].score;
  if (top <= 0) return results;
  const floor = top * fraction;
  return results.filter((r) => r.score >= floor);
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
