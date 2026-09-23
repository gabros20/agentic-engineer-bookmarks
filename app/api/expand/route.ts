import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { generateQueryRewrites } from "@/lib/server/query-expand";

export const runtime = "nodejs";
export const maxDuration = 15;

const expandRequestSchema = z.object({
  query: z.string().min(1).max(200),
  language: z.enum(["en", "hu"]),
});

export async function POST(request: NextRequest) {
  // Session gate only — no separate quota bucket. /api/expand only fires on broad search
  // (cheap query rewrites), and that path is already bounded by the 300/day search quota (T4).
  // The legacy digest-unlock passkey is retired: the whole app is already behind login.
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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

  // Prompt + model live in lib/server/query-expand.ts (shared with the MCP search tool).
  const rewrites = await generateQueryRewrites(query, request.signal);
  return NextResponse.json({ rewrites });
}
