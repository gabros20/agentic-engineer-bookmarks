import { streamObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { NextResponse, type NextRequest } from "next/server";
import { digestRequestSchema, digestSchema } from "@/lib/digest-schema";
import { buildDigestUserPrompt, getDigestSystemPrompt } from "@/lib/digest-prompt";

export const runtime = "nodejs";
// The digest now clusters ~50 Worker-reranked sources (up from ~30) with gemini-3.6-flash, so a
// single generation can run longer than the old 60s ceiling. Vercel Fluid Compute allows up to
// 300s; 120s gives comfortable headroom for a large streamed digest without an open-ended cap.
export const maxDuration = 120;

// T1 (digest engine upgrade): gemini-3.6-flash — stronger synthesis + reliable
// structured output/HU output than the previous nano tier, still cheap, for a deeper
// (~50-source) input. Verified live via streamObject through OpenRouter (see
// .orchestrate/task-1-report.md); no providerOptions needed — this route never set
// OpenAI-style `reasoning.effort`, so there's nothing Gemini-specific to adapt here.
const MODEL = "google/gemini-3.6-flash";

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

  const parsed = digestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const { query, sources, language } = parsed.data;

  const openrouter = createOpenRouter();
  const model = openrouter.chat(MODEL);

  const result = streamObject({
    model,
    schema: digestSchema,
    system: getDigestSystemPrompt(language),
    prompt: buildDigestUserPrompt(query, sources, language),
    temperature: 0.3,
  });

  return result.toTextStreamResponse();
}
