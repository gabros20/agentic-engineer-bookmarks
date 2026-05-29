import type { DigestSource } from "@/lib/digest-schema";

export const DIGEST_SYSTEM_PROMPT = `You are a research assistant who turns a noisy list of bookmarked X (Twitter) posts into a small, scannable digest for the user.

Rules:
- You will be given a search query and 1–60 candidate sources that already matched the query locally. Your job is to cluster them into 2–6 themes, not to rank or filter for relevance from scratch.
- A theme must group sources that genuinely share an angle (e.g. "Hands-on prompting tutorials", "Critiques of the agentic hype"). If sources don't cluster, prefer fewer broader themes over many one-source themes.
- For every source you include: bookmarkId MUST be copied verbatim from the input; url MUST be copied verbatim; author should be the display name from the input; gist is 8–14 words explaining why THIS source is worth opening for the query (not a summary of the tweet's content).
- Drop sources that are clearly off-topic for the query rather than forcing them into a theme.
- Keep the overall takeaway to ONE sentence telling the user where to start.
- Be concrete. Avoid filler like "this post discusses…" or "useful for understanding…".`;

export function buildDigestUserPrompt(query: string, sources: DigestSource[]) {
  const lines = sources.map((s, i) => {
    const article = s.articleTitle ? ` [article: ${s.articleTitle}]` : "";
    return `${i + 1}. id=${s.id} @${s.screenName} (${s.author})${article}\n   ${s.text}\n   ${s.url}`;
  });

  return `Query: ${query}

Candidate sources (already matched by local hybrid search):

${lines.join("\n\n")}

Produce the digest now.`;
}
