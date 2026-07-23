import { z } from "zod";

// Input schemas for the chat agent's tools. Shared between the server
// (where tools are registered with the ToolLoopAgent, schema-only) and
// the client (where the actual `execute` function lives, using the
// already-loaded browser bookmark + embedding state).

export const searchBookmarksInputSchema = z.object({
  query: z.string().min(1).max(200).describe("Search query in natural language"),
  precision: z
    .enum(["exact", "broad"])
    .default("broad")
    .describe(
      "exact = no synonym expansion, keyword-weighted, narrow; broad = synonym expansion, semantic-weighted, wide. Use exact for short literal queries (handles, exact terms), broad for vibes/topics.",
    ),
  limit: z
    .number()
    .min(1)
    .max(60)
    .default(35)
    .describe("Maximum results to return (default 35, max 60). Raise it for broad/enumerative questions."),
  filter: z
    .enum(["all", "article", "media", "text"])
    .default("all")
    .describe("Optional content-type filter"),
});

export type SearchBookmarksInput = z.infer<typeof searchBookmarksInputSchema>;

export const searchBookmarksResultSchema = z.object({
  count: z.number(),
  results: z.array(
    z.object({
      id: z.string(),
      author: z.string(),
      screenName: z.string(),
      text: z.string(),
      articleTitle: z.string().optional(),
      url: z.string(),
      createdAt: z.string().optional(),
      likes: z.number().optional(),
      bookmarks: z.number().optional(),
    }),
  ),
});

export type SearchBookmarksResult = z.infer<typeof searchBookmarksResultSchema>;

export const getBookmarkInputSchema = z.object({
  id: z.string().describe("Bookmark id (matches an id from search_bookmarks results)"),
});

export type GetBookmarkInput = z.infer<typeof getBookmarkInputSchema>;

export const getBookmarkResultSchema = z.object({
  found: z.boolean(),
  bookmark: z
    .object({
      id: z.string(),
      author: z.string(),
      screenName: z.string(),
      text: z.string(),
      articleTitle: z.string().optional(),
      articleText: z.string().optional(),
      url: z.string(),
      createdAt: z.string().optional(),
      metrics: z
        .object({
          likes: z.number().optional(),
          retweets: z.number().optional(),
          replies: z.number().optional(),
          views: z.number().optional(),
          bookmarks: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type GetBookmarkResult = z.infer<typeof getBookmarkResultSchema>;
