import lunr from "lunr";
import type { BookmarkPost } from "@/lib/bookmark-types";

export type SearchIndexPayload = {
  ok: boolean;
  schema_version: string;
  generated_at?: string;
  source?: string;
  model: string;
  dimensions: number;
  count: number;
  items: Array<{
    id: string;
    text: string;
    embedding: number[];
  }>;
};

export type SearchResult = {
  id: string;
  score: number;
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
  try {
    return index.search(query).map((result) => ({
      id: result.ref,
      score: result.score,
    }));
  } catch {
    return index.search(`${lunr.tokenizer(query).map((token) => `${token}~1`).join(" ")}`).map((result) => ({
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

export function mergeHybridResults(keywordResults: SearchResult[], vectorResults: SearchResult[]) {
  const scores = new Map<string, number>();
  addReciprocalRanks(scores, keywordResults, 0.45);
  addReciprocalRanks(scores, vectorResults, 0.55);

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

function addReciprocalRanks(scores: Map<string, number>, results: SearchResult[], weight: number) {
  const k = 60;
  for (const [index, result] of results.entries()) {
    scores.set(result.id, (scores.get(result.id) ?? 0) + weight / (k + index + 1));
  }
}

function dotProduct(a: number[], b: number[]) {
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    total += (a[index] ?? 0) * (b[index] ?? 0);
  }
  return total;
}
