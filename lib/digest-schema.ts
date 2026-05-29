import { z } from "zod";

export const digestSourceSchema = z.object({
  id: z.string(),
  author: z.string(),
  screenName: z.string(),
  text: z.string(),
  articleTitle: z.string().optional(),
  url: z.string(),
});

export const digestRequestSchema = z.object({
  query: z.string().min(1).max(500),
  sources: z.array(digestSourceSchema).min(1).max(60),
});

export const digestSchema = z.object({
  themes: z.array(
    z.object({
      title: z.string().describe("3–6 word cluster title"),
      summary: z.string().describe("1–2 sentence synthesis of what these sources collectively cover"),
      sources: z.array(
        z.object({
          bookmarkId: z.string().describe("must match an id from the input sources array"),
          author: z.string().describe("author display name"),
          gist: z.string().describe("8–14 word reason this source matters for the query"),
          url: z.string().describe("x.com URL from the input source"),
        }),
      ),
    }),
  ),
  overall: z.string().describe("1 sentence describing where to start"),
});

export type DigestSource = z.infer<typeof digestSourceSchema>;
export type DigestRequest = z.infer<typeof digestRequestSchema>;
export type Digest = z.infer<typeof digestSchema>;
