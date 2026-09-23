import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject } from "ai";
import { z } from "zod";

// ---------------------------------------------------------------------------
// LLM query rewrites (translation + synonym-rich rephrase + narrower variant).
// Single source for the prompt/model, shared by the session-gated /api/expand
// route (browser broad search) and the MCP search tool (lib/server/bookmark-
// service.ts). Server-only: needs OPENROUTER_API_KEY.
// ---------------------------------------------------------------------------

// Same model as digest/chat: fast, cheap, follows short-output instructions reliably.
const MODEL = "openai/gpt-5.4-nano";

export const expandSchema = z.object({
  rewrites: z.array(z.string()).max(3),
});

const SYSTEM_PROMPT = [
  "You rewrite a user's search query for semantic search over an English-language tech/AI",
  "bookmark archive (X/Twitter posts and linked articles about AI agents, LLMs, coding tools).",
  "Return up to 3 SHORT search rewrites of the user's query:",
  "1. An English translation of the query, if the query is not already English.",
  "2. An English synonym-rich rephrase of the query using domain vocabulary.",
  "3. A narrower, more specific English variant of the query.",
  "Skip a rewrite that would not apply (e.g. skip the translation if the query is already English).",
  "Rules: no explanations, no labels, no numbering, no duplicates of the input query, no duplicate",
  "rewrites of each other. Each rewrite is a short search phrase, not a sentence.",
].join(" ");

/** Throws on LLM/network failure — callers choose whether that is fatal. */
export async function generateQueryRewrites(query: string, abortSignal?: AbortSignal): Promise<string[]> {
  const openrouter = createOpenRouter();
  const result = await generateObject({
    model: openrouter.chat(MODEL),
    schema: expandSchema,
    system: SYSTEM_PROMPT,
    prompt: `Query: ${query}`,
    temperature: 0.2,
    abortSignal,
  });
  return result.object.rewrites;
}
