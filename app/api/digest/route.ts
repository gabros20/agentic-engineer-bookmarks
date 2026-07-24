import { streamObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { NextResponse, after, type NextRequest } from "next/server";
import { digestRequestSchema, digestSchema } from "@/lib/digest-schema";
import { buildDigestUserPrompt, getDigestSystemPrompt } from "@/lib/digest-prompt";
import { enforceQuota, requireUser } from "@/lib/api-guard";
import { db } from "@/lib/db";
import { savedDigests } from "@/lib/db/schema";

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

// T5: per-user digests/day. The 11th digest of a UTC day → 429. Same atomic ON CONFLICT
// pattern app/api/search/route.ts established for search; increment happens BEFORE the
// OpenRouter call so an over-limit request never bills a generation.
const DAILY_DIGEST_LIMIT = 10;

export async function POST(request: NextRequest) {
  // 1. Session gate — same DB-backed lookup as the search proxy (T4) and the login wall (T3).
  //    The legacy digest-unlock passkey is retired: the whole app is already behind login.
  const gate = await requireUser();
  if (!gate.ok) return gate.response;
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

  // 2. Atomic per-user daily quota (shared helper). Increments today's counter before OpenRouter,
  //    so an over-limit request never bills a generation. A quota-DB failure returns a clean JSON
  //    500 (never a framework stack); over-limit returns a 429 { code: "digest_quota" } the UI
  //    localizes.
  const overLimit = await enforceQuota(gate.userId, "digest", DAILY_DIGEST_LIMIT);
  if (overLimit) return overLimit;

  const openrouter = createOpenRouter();
  const model = openrouter.chat(MODEL);

  const userId = gate.userId;
  const sourceIds = sources.map((s) => s.id);

  const result = streamObject({
    model,
    schema: digestSchema,
    system: getDigestSystemPrompt(language),
    prompt: buildDigestUserPrompt(query, sources, language),
    temperature: 0.3,
    // 3. Persist server-side when the generation completes. onFinish fires from the stream's
    //    flush, i.e. only once the stream is pulled to completion — which is why the response
    //    below tees the stream and drains one branch server-side, so this runs even if the
    //    client closes the tab mid-stream. Only a valid, error-free object is saved.
    onFinish: async ({ object, error }) => {
      if (error || !object) return;
      try {
        // T6 fix (I2): dedupe-on-write. UNIQUE(userId, query) + onConflictDoUpdate means a
        // regenerated digest REPLACES the prior row for the same (user, query) rather than
        // appending — one row per query, so deleting the shown digest can't resurface an older
        // generation. createdAt is refreshed so the list's newest-first order reflects the
        // latest regeneration.
        await db
          .insert(savedDigests)
          .values({
            id: crypto.randomUUID(),
            userId,
            title: query,
            query,
            precision: null, // digestRequestSchema carries no precision; T6 may thread it through.
            content: object,
            sourceIds,
            language,
          })
          .onConflictDoUpdate({
            target: [savedDigests.userId, savedDigests.query],
            set: {
              title: query,
              precision: null,
              content: object,
              sourceIds,
              language,
              createdAt: new Date(),
            },
          });
      } catch (err) {
        // A failed persist must not surface as a stream error to the client (the digest still
        // rendered). Log and move on; the client-side cache still holds this digest for now.
        console.error("[digest] failed to persist saved_digests row:", err);
      }
    },
  });

  // 4. Reproduce toTextStreamResponse's wire format (text/plain UTF-8 JSON deltas, consumed by
  //    the client's experimental_useObject) but tee it: one branch streams to the client, the
  //    other is drained server-side via `after()`. streamObject has no consumeStream(), and its
  //    baseStream is single-consumer — so teeing is how we guarantee the stream reaches its
  //    flush (and thus onFinish persists) regardless of whether the client stays connected.
  const encoder = new TextEncoder();
  const byteStream = result.textStream.pipeThrough(
    new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(encoder.encode(chunk));
      },
    }),
  );
  const [clientBranch, serverBranch] = byteStream.tee();

  after(async () => {
    // Drain the server-side branch to completion. As long as this branch keeps reading, a
    // client disconnect (which cancels only clientBranch) cannot stop generation — a tee's
    // source is cancelled only when BOTH branches are. Reaching `done` means the stream
    // flushed, which is where onFinish ran the persist above.
    const reader = serverBranch.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
      // Swallow: whatever aborted generation also rejected onFinish's object guard.
    } finally {
      reader.releaseLock();
    }
  });

  return new Response(clientBranch, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
