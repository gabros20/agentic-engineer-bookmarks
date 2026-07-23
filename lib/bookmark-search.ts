import lunr from "lunr";
import type { BookmarkPost } from "@/lib/bookmark-types";

// Task 14 single-sourcing: searchText used to be re-declared here, drifted from
// scripts/lib/embed.mjs's copy (this one joined raw post.urls with "\n"; embed.mjs's
// collapses whitespace and reduces urls to registrable domains — Task 5). embed.mjs is the
// canonical home (it's also the text the embedder actually indexes against), so this is now
// a straight re-export via the typed wrapper (scripts/lib/embed.d.ts — see that file for why
// the extension-less specifier). Behavior change, scoped to this module's callers: any
// caller of lib/bookmark-search.ts's `searchText` (currently none inside this app — it's
// exported for the keyword-only fallback path/external use) now sees post.urls as domains,
// not raw URLs, matching what actually gets embedded/what scripts/bookmark-search.mjs (the
// CLI, also rebuilt on embed.mjs in Task 14) produces. Acceptable and noted per the brief.
export { searchText } from "@/scripts/lib/embed";

export type SearchIndexPayload = {
  ok: boolean;
  schema_version: string;
  generated_at?: string;
  source?: string;
  model: string;
  prefix_scheme?: "e5";
  dimensions: number;
  encoding?: "float32" | "int8_normalized";
  count: number;
  vector_count?: number;
  items: Array<{
    id: string;
    part?: number;
    embedding: number[];
  }>;
};

export type SearchResult = {
  id: string;
  score: number;
};

export type SearchPrecision = "exact" | "broad";

const HYBRID_WEIGHTS: Record<SearchPrecision, { keyword: number; vector: number }> = {
  exact: { keyword: 0.6, vector: 0.4 },
  broad: { keyword: 0.35, vector: 0.65 },
};

/**
 * Task 2 (handle recall recovery): RRF weight override for bare single-token exact queries
 * (e.g. "rauchg", "mattpocockuk") on the bge-m3 index ONLY (gated in runHybridPipeline by
 * `isBge && bareHandle`, exact precision). A prior experiment (skip rerank for handles)
 * FAILED — the reranker measurably HELPS handle once a relevant post reaches its window; the
 * regression is upstream, in the pre-rerank hybrid merge not surfacing exact-author keyword
 * hits into the top ranks / RERANK_WINDOW. This pushes the merge fully keyword-driven for that
 * narrow case only. Multi-token exact queries and broad mode are untouched (they keep
 * HYBRID_WEIGHTS), and the e5 path never sees this (gated off `isBge` in runHybridPipeline) —
 * additive/defaulted, so e5 stays byte-identical.
 *
 * Sweep against the live Worker (eval-bge.mjs, .orchestrate/task-2-report.md), handle
 * recall@10/mrr@10/ndcg@10, every other class byte-identical at every step (the golden set has
 * no non-handle single-token exact query, so this weight structurally cannot move them):
 *   0.60/0.40 (baseline, HYBRID_WEIGHTS.exact) -> 0.25 / 0.0875 / 0.1184
 *   0.85/0.15                                  -> 0.75 / 0.2257 / 0.3691
 *   1.00/0.00 (selected)                       -> 0.8333 / 0.3819 / 0.4859
 * 1.00/0.00 strictly dominated 0.85/0.15 on every handle metric with zero measured downside,
 * so it was kept over a fractional weight. At vector weight 0, a post found ONLY by the vector
 * side still surfaces (RRF still adds it at score 0, stable-sorted behind every keyword hit) —
 * this degrades to vector rank order for the keyword-miss tail rather than dropping results.
 */
const BGE_HANDLE_HYBRID_WEIGHTS = { keyword: 1.0, vector: 0.0 };

const QUERY_EXPANSIONS: Record<string, string[]> = {
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

// Cap the article body fed into lunr: article bodies are median ~1.7k WORDS, and lunr
// indexes at build time in the browser on ~5,370 posts per page load — indexing full
// bodies would blow up index build time/memory. 2,000 chars keeps that sane while still
// covering the lead of the article (where distinctive phrasing tends to live).
const ARTICLE_INDEX_CHAR_LIMIT = 2000;

export function buildKeywordIndex(posts: BookmarkPost[]) {
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

export function keywordSearch(index: lunr.Index, query: string) {
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
function scorePerIdMax(items: SearchIndexPayload["items"], queryEmbedding: number[]) {
  const byId = new Map<string, number>();
  for (const item of items) {
    const score = dotProduct(queryEmbedding, item.embedding);
    const prev = byId.get(item.id);
    if (prev === undefined || score > prev) byId.set(item.id, score);
  }
  return byId;
}

export function vectorSearch(index: SearchIndexPayload, queryEmbedding: number[]) {
  return [...scorePerIdMax(index.items, queryEmbedding).entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export function multiVectorSearch(index: SearchIndexPayload, queryEmbeddings: number[][]) {
  if (!queryEmbeddings.length) return [];

  // Per query embedding: max-pool per id across items (main + chunks) first, so a
  // multi-part bookmark contributes one score per query, not one per vector.
  const perQueryScores = queryEmbeddings.map((embedding) => scorePerIdMax(index.items, embedding));

  const ids = new Set(index.items.map((item) => item.id));
  const results: SearchResult[] = [];

  for (const id of ids) {
    let best = Number.NEGATIVE_INFINITY;
    let average = 0;

    for (const scores of perQueryScores) {
      // Invariant: `ids` is built from `index.items`, and `scorePerIdMax` scores every
      // item in `index.items` for every query embedding — so `id` is always present in
      // every per-query map. If that ever stops holding (e.g. a future top-k prune inside
      // scorePerIdMax), fail loudly rather than silently blending in -Infinity.
      if (!scores.has(id)) throw new Error(`multiVectorSearch: id "${id}" missing from a per-query score map`);
      const score = scores.get(id) as number;
      best = Math.max(best, score);
      average += score;
    }

    results.push({ id, score: best * 0.8 + (average / perQueryScores.length) * 0.2 });
  }

  return results.sort((a, b) => b.score - a.score);
}

export function mergeHybridResults(
  keywordResults: SearchResult[],
  vectorResults: SearchResult[],
  precision: SearchPrecision = "broad",
  weightsOverride?: { keyword: number; vector: number },
) {
  const { keyword, vector } = weightsOverride ?? HYBRID_WEIGHTS[precision];
  const scores = new Map<string, number>();
  addReciprocalRanks(scores, keywordResults, keyword);
  addReciprocalRanks(scores, vectorResults, vector);

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export function expandSemanticQueries(query: string, precision: SearchPrecision = "broad") {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (precision === "exact") return normalized ? [normalized] : [];

  const terms = queryTerms(normalized);
  const expansions = new Set<string>([normalized]);
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
export function applyRelativeFloor(results: SearchResult[], fraction: number, minKeep = 0) {
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
 * Broad-mode relevance floors for the bge-m3 index (model "@cf/baai/bge-m3", the Cloudflare
 * Worker pipeline — Task 3), calibrated by scripts/calibrate-floors-bge.mjs on 2026-07-23.
 * bge-m3 cosines top ~0.67 (T0 spike / T2), so e5's 0.82 absolute floor is INVALID here (it
 * zeros everything) — these are the bge-specific replacements.
 *
 * BGE_BROAD_MERGED_RELATIVE_FLOOR (0.5) is the primary tail-shaper and is model-INDEPENDENT
 * (RRF scores are model-agnostic), so it matches e5's BROAD_MERGED_RELATIVE_FLOOR: it brings
 * the semantic-only broad result set from the 900-slice cap down to a median of ~62 on the
 * golden queries — the same order as the e5 baseline's broad tail (median 42 / p90 62).
 *
 * BGE_BROAD_VECTOR_COSINE_FLOOR (0.40) is a CONSERVATIVE absolute deep-noise backstop, not the
 * primary shaper. The sweep showed that at rel=0.5 every absolute floor from `none` up to 0.52
 * is indistinguishable (tail 62, recall@10 0.4444, window-recall 0.5833 all identical) — so
 * 0.40 is a no-op on the golden set (ZERO measured recall loss) while still flooring clearly
 * unrelated content (< 0.40 cosine) for pathological weak-top queries. The sweep's mechanical
 * "smallest-tail" tie-break selected 0.56 (median 25), but 0.56 sits INSIDE the relevant
 * cosine band (relevant docs ~0.55-0.67) — too aggressive for an inclusive BROAD search and a
 * real risk of cutting legitimate 0.50-0.56 paraphrase/topic matches or zeroing weak but valid
 * queries — so it was deliberately rejected in favor of the conservative end of the
 * indistinguishable range. See .orchestrate/task-3-report.md for the full sweep grid.
 *
 * GATE STATUS (task-3-report.md): the semantic-only bge Worker pipeline FAILED the e5 gate
 * (handle + article-title classes regress without keyword/lunr). These floors do NOT cause
 * that regression (they only bound the broad tail; they never reduce recall) and are wired for
 * correctness, but if keyword is added back the floors should be re-swept for the hybrid tail.
 */
export const BGE_BROAD_VECTOR_COSINE_FLOOR = 0.4;
export const BGE_BROAD_MERGED_RELATIVE_FLOOR = 0.5;

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
export function applyAbsoluteVectorFloor(results: SearchResult[], cosineFloor: number) {
  if (!cosineFloor || cosineFloor <= 0) return results;
  const floor = cosineFloor * INT8_VECTOR_SCALE;
  return results.filter((r) => r.score >= floor);
}

/**
 * Runs the full hybrid pipeline: absolute vector floor (broad mode) -> slice(0,900) -> RRF
 * merge -> relative floor. Shared by the client (components/bookmarks-app.tsx, both the main
 * search effect and runChatSearch), the Cloudflare Worker (worker/src/index.ts), and mirrored
 * verbatim as scripts/lib/search-core.mjs's runHybridPipeline so the eval harnesses run the
 * identical pipeline (review-task6-quality-r1 F2).
 *
 * Broad-mode floors are MODEL-SPECIFIC (cosine distributions differ per embedding model), so
 * the calibrated constants are selected by the loaded index's model:
 *   - e5 v2 index (prefix_scheme "e5"): BROAD_VECTOR_COSINE_FLOOR (0.82) + BROAD_MERGED_
 *     RELATIVE_FLOOR (0.5). UNCHANGED — this path stays byte-identical (the client still uses
 *     the e5 index until the Cloudflare cutover, T4).
 *   - bge-m3 index (model "@cf/baai/bge-m3"): BGE_BROAD_VECTOR_COSINE_FLOOR (0.40) + BGE_BROAD_
 *     MERGED_RELATIVE_FLOOR (0.5), calibrated in T3 (bge cosines top ~0.67, so e5's 0.82 would
 *     zero everything). Keyed off `model`, NOT prefix_scheme (bge is prefix-free).
 *   - any other index (v1 MiniLM, etc.): no broad floors — unchanged, unfloored behavior.
 * Broad mode's relative floor applies BROAD_FLOOR_MIN_KEEP (model-independent structural rank
 * guard, review-task6-quality-r1 F1); exact mode keeps its hardcoded 0.5 relative floor
 * untouched for every model, no minKeep.
 *
 * `opts.bareHandle` (Task 2, default false/absent): when true AND the loaded index is bge-m3
 * AND precision is "exact", the merge uses BGE_HANDLE_HYBRID_WEIGHTS instead of
 * HYBRID_WEIGHTS.exact — see that constant's doc comment. Callers compute the bare-single-
 * token-query signal themselves (worker/src/index.ts, scripts/lib/search-core.mjs's mirror);
 * this function never inspects the raw query string. Absent/false is a no-op — identical to
 * pre-Task-2 behavior — so the e5 path (which never sets it) stays byte-identical, and the bge
 * path is unaffected unless a caller explicitly opts in.
 */
export function runHybridPipeline(
  keywordResults: SearchResult[],
  pooledVectorResults: SearchResult[],
  precision: SearchPrecision,
  index: SearchIndexPayload,
  opts: { bareHandle?: boolean } = {},
) {
  const isE5 = index.prefix_scheme === "e5";
  const isBge = index.model === "@cf/baai/bge-m3";
  const floorsActive = isE5 || isBge;
  const absFloor = isE5 ? BROAD_VECTOR_COSINE_FLOOR : isBge ? BGE_BROAD_VECTOR_COSINE_FLOOR : 0;
  const relFloor = isE5 ? BROAD_MERGED_RELATIVE_FLOOR : isBge ? BGE_BROAD_MERGED_RELATIVE_FLOOR : 0;
  const vectorResults = (
    precision === "broad" && floorsActive
      ? applyAbsoluteVectorFloor(pooledVectorResults, absFloor)
      : pooledVectorResults
  ).slice(0, 900);
  const useHandleWeights = isBge && precision === "exact" && Boolean(opts.bareHandle);
  const merged = mergeHybridResults(
    keywordResults,
    vectorResults,
    precision,
    useHandleWeights ? BGE_HANDLE_HYBRID_WEIGHTS : undefined,
  );
  if (precision === "exact") return applyRelativeFloor(merged, 0.5);
  return floorsActive ? applyRelativeFloor(merged, relFloor, BROAD_FLOOR_MIN_KEEP) : merged;
}

function addReciprocalRanks(scores: Map<string, number>, results: SearchResult[], weight: number) {
  const k = 60;
  for (const [index, result] of results.entries()) {
    scores.set(result.id, (scores.get(result.id) ?? 0) + weight / (k + index + 1));
  }
}

function queryTerms(query: string) {
  return lunr.tokenizer(query).map((token) => String(token)).filter(Boolean);
}

function dotProduct(a: number[], b: number[]) {
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return total;
}
