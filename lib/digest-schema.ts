import { z } from "zod";

export const digestSourceSchema = z.object({
  id: z.string(),
  author: z.string(),
  screenName: z.string(),
  text: z.string(),
  articleTitle: z.string().optional(),
  articleExcerpt: z.string().optional(),
  url: z.string(),
});

export const digestRequestSchema = z.object({
  query: z.string().min(1).max(500),
  sources: z.array(digestSourceSchema).min(1).max(60),
  language: z.enum(["en", "hu"]).default("en"),
});

// T1 (digest engine upgrade): richer output contract. Sourced from a Worker re-query at
// ~50 (deeper + reranked, not just the 30 on-screen posts) and synthesized by a stronger
// model (gemini-3.6-flash) — see lib/digest-prompt.ts. Breadth-favoring: the prompt is
// told to include every relevant source and only drop true noise.
//
// `overall` is KEPT (not folded into `tldr`) deliberately: lib/digest-cache.ts's
// `SavedDigest` (T2-owned) and components/digest-panel.tsx (T2-owned) already require a
// non-empty `overall` string to render the "start here" strip and to gate saving to the
// cache. Removing it here would break their TS compile out from under T2 before T2 has
// run. `tldr` and `overall` are NOT redundant: `overall` stays a ONE-sentence "where to
// start" pointer (unchanged meaning); `tldr` is new — a 2-3 sentence synthesis of what the
// sources COLLECTIVELY say about the query, independent of "where to start". T2 owns
// deciding whether the redesigned panel keeps rendering both or drops `overall` from its
// own SavedDigest/UI once it updates digest-cache.ts + digest-panel.tsx.
export const digestSchema = z.object({
  tldr: z
    .string()
    .describe(
      "2-3 sentence synthesis of what the saved sources COLLECTIVELY say about the query — the headline takeaway, not where to start reading.",
    ),
  overall: z.string().describe("ONE sentence telling the user where to start."),
  themes: z
    .array(
      z.object({
        title: z.string().describe("3-6 word cluster title"),
        summary: z.string().describe("2-3 sentence synthesis of what these sources collectively cover"),
        sources: z
          .array(
            z.object({
              bookmarkId: z.string().describe("must match an id from the input sources array, copied verbatim"),
              author: z.string().describe("author display name, copied verbatim from the input"),
              gist: z.string().describe("8-14 word reason this source matters for the query"),
              url: z.string().describe("x.com URL copied verbatim from the input source"),
            }),
          )
          .describe("EVERY relevant source for this theme — do not sample or cap arbitrarily"),
      }),
    )
    .max(8)
    .describe("up to ~8 genuine thematic angles across the sources"),
  readFirst: z
    .array(
      z.object({
        bookmarkId: z.string().describe("must match an id from the input sources array, copied verbatim"),
        author: z.string().describe("author display name, copied verbatim from the input"),
        why: z.string().describe("one line: why this is a top starting point for the query"),
        url: z.string().describe("x.com URL copied verbatim from the input source"),
      }),
    )
    .min(3)
    .max(5)
    .describe("3-5 highest-signal starting points, pulled from across the themes"),
  deeperReads: z
    .array(
      z.object({
        bookmarkId: z.string().describe("must match an id from the input sources array, copied verbatim"),
        articleTitle: z.string().describe("copied verbatim from the input source's article title"),
        author: z.string().describe("author display name, copied verbatim from the input"),
        why: z.string().describe("one line: why this article is worth a deep read for the query"),
        url: z.string().describe("x.com URL copied verbatim from the input source"),
      }),
    )
    .optional()
    .describe(
      "article bookmarks (sources that had an excerpt) worth a deep read — omit or leave empty if none of the sources are articles worth calling out",
    ),
});

export type DigestSource = z.infer<typeof digestSourceSchema>;
export type DigestRequest = z.infer<typeof digestRequestSchema>;
export type Digest = z.infer<typeof digestSchema>;
