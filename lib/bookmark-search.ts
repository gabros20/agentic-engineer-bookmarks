import lunr from "lunr";
import type { BookmarkPost } from "@/lib/bookmark-types";

export type SearchIndexPayload = {
  ok: boolean;
  schema_version: string;
  generated_at?: string;
  source?: string;
  model: string;
  dimensions: number;
  encoding?: "float32" | "int8_normalized";
  count: number;
  items: Array<{
    id: string;
    embedding: number[];
  }>;
};

export type SearchResult = {
  id: string;
  score: number;
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

export function vectorSearch(index: SearchIndexPayload, queryEmbedding: number[]) {
  return index.items
    .map((item) => ({
      id: item.id,
      score: dotProduct(queryEmbedding, item.embedding),
    }))
    .sort((a, b) => b.score - a.score);
}

export function multiVectorSearch(index: SearchIndexPayload, queryEmbeddings: number[][]) {
  if (!queryEmbeddings.length) return [];

  return index.items
    .map((item) => {
      let best = Number.NEGATIVE_INFINITY;
      let average = 0;

      for (const embedding of queryEmbeddings) {
        const score = dotProduct(embedding, item.embedding);
        best = Math.max(best, score);
        average += score;
      }

      return {
        id: item.id,
        score: best * 0.8 + (average / queryEmbeddings.length) * 0.2,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function mergeHybridResults(keywordResults: SearchResult[], vectorResults: SearchResult[]) {
  const scores = new Map<string, number>();
  addReciprocalRanks(scores, keywordResults, 0.35);
  addReciprocalRanks(scores, vectorResults, 0.65);

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

export function expandSemanticQueries(query: string) {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
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
