import { streamObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { NextResponse, type NextRequest } from "next/server";
import { digestRequestSchema, digestSchema } from "@/lib/digest-schema";
import { buildDigestUserPrompt, getDigestSystemPrompt } from "@/lib/digest-prompt";

export const runtime = "nodejs";
export const maxDuration = 60;

// gpt-4.1-nano is fast (~5-7s for 30 sources), cheap, follows the
// language instruction reliably for both EN and HU, and produces
// well-clustered themes via OpenRouter tool calling.
const MODEL = "openai/gpt-5.4-nano";

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
