import { generateObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 15;

// Same model as digest/chat: fast, cheap, follows short-output instructions reliably.
const MODEL = "openai/gpt-5.4-nano";

const expandRequestSchema = z.object({
  query: z.string().min(1).max(200),
  language: z.enum(["en", "hu"]),
});

const expandSchema = z.object({
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

export async function POST(request: NextRequest) {
  const expected = process.env.DIGEST_UNLOCK_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  const cookie = request.cookies.get("digest_unlock")?.value;
  if (cookie !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.OPENROUTER_API_KEY) {
    return NextResponse.json({ error: "OPENROUTER_API_KEY unset" }, { status: 500 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = expandRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  // F3: `language` (UI display-locale toggle, not detected query-text language) is
  // intentionally NOT read out of parsed.data here and NOT put in the prompt. It stays in
  // expandRequestSchema for API compat (older/other clients may still send it), but it must
  // never suppress translation for a bilingual user who leaves the UI in "en" while typing a
  // Hungarian query. SYSTEM_PROMPT's rule 1 ("if the query is not already English") is
  // content-conditioned on the query text itself, which the model can always see — so
  // dropping the hint just removes a source of contradictory signal, it doesn't remove the
  // model's ability to detect language.
  const { query } = parsed.data;

  const openrouter = createOpenRouter();
  const model = openrouter.chat(MODEL);

  const result = await generateObject({
    model,
    schema: expandSchema,
    system: SYSTEM_PROMPT,
    prompt: `Query: ${query}`,
    temperature: 0.2,
    abortSignal: request.signal,
  });

  return NextResponse.json(result.object);
}
