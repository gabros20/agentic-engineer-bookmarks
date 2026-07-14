import lunr from "lunr";
import type { BookmarkPost } from "@/lib/bookmark-types";

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

export function searchText(post: BookmarkPost) {
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

export function buildKeywordIndex(posts: BookmarkPost[]) {
  return lunr(function build() {
    this.ref("id");
    this.field("text", { boost: 4 });
    this.field("title", { boost: 5 });
    this.field("author", { boost: 2 });
    this.field("url");

    for (const post of posts) {
      this.add({
        id: post.id,
        text: post.text,
        title: post.articleTitle ?? "",
        author: `${post.author.name} ${post.author.screenName}`,
        url: (post.urls ?? []).join(" "),
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
) {
  const { keyword, vector } = HYBRID_WEIGHTS[precision];
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

export function applyRelativeFloor(results: SearchResult[], fraction: number) {
  if (!results.length || fraction <= 0) return results;
  const top = results[0].score;
  if (top <= 0) return results;
  const floor = top * fraction;
  return results.filter((r) => r.score >= floor);
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
