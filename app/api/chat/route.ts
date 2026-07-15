import { convertToModelMessages, stepCountIs, streamText, tool, type UIMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { buildChatContextBlock, getChatSystemPrompt, type ChatContext } from "@/lib/chat-prompt";
import { getBookmarkInputSchema, searchBookmarksInputSchema } from "@/lib/chat-tools";

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = "openai/gpt-5.4-nano";

const requestSchema = z.object({
  messages: z.array(z.unknown()),
  context: z
    .object({
      language: z.enum(["en", "hu"]).default("en"),
      query: z.string().nullable().default(null),
      precision: z.enum(["exact", "broad"]).nullable().default(null),
      sources: z.array(z.unknown()).default([]),
      digest: z.unknown().nullable().default(null),
      // Task 14: live archive size (posts.length), threaded from the client so the system
      // prompt's "~N saved posts" stays in sync instead of a hardcoded, drifting figure.
      // Optional/nullable so an older cached client bundle (or any other future caller of
      // this route) that doesn't send it still gets a valid request — getChatSystemPrompt
      // falls back to the original static text when this is null/absent.
      archiveCount: z.number().nullable().default(null),
    })
    .default({ language: "en", query: null, precision: null, sources: [], digest: null, archiveCount: null }),
});

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

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
  }
  const { messages, context } = parsed.data;

  const system = [
    getChatSystemPrompt(context.language, context.archiveCount),
    "",
    buildChatContextBlock(context as ChatContext),
  ].join("\n");

  const openrouter = createOpenRouter();
  const model = openrouter.chat(MODEL);

  const modelMessages = await convertToModelMessages(messages as UIMessage[]);

  const result = streamText({
    model,
    system,
    messages: modelMessages,
    tools: {
      // Schema-only tools. The actual `execute` lives on the client
      // (browser already has the bookmark JSON + embedding model loaded).
      search_bookmarks: tool({
        description:
          "Search the bookmark archive using local hybrid (keyword + semantic) search. Returns ranked matches.",
        inputSchema: searchBookmarksInputSchema,
      }),
      get_bookmark: tool({
        description: "Fetch the full text of a single bookmark by id.",
        inputSchema: getBookmarkInputSchema,
      }),
    },
    stopWhen: stepCountIs(10),
    temperature: 0.2,
    providerOptions: {
      openrouter: {
        reasoning: { effort: "medium" },
      },
    },
  });

  return result.toUIMessageStreamResponse();
}
