# AI Digest + chat upgrade plan

Make the AI Digest and ⌘K chat genuinely leverage the new Cloudflare Worker search: more relevant + more results, a richer output format, and a stronger model. Decisions locked with the user.

**Branch:** `digest-upgrade` · **Strategy:** /orchestrate staged, sonnet workers, dual review.

## Decisions (user-confirmed)
- **Model:** `google/gemini-3.6-flash` for BOTH `/api/digest` and `/api/chat` (was `openai/gpt-5.4-nano`). Best synthesis + Hungarian + reliable structured-output/tool-calling; ~pennies per use. (Verify streamObject structured output + tool-calling work with Gemini via the `@openrouter/ai-sdk-provider`; the OpenAI-style `providerOptions.openrouter.reasoning.effort` may need adapting/removing for Gemini.)
- **Digest sourcing:** re-query the Worker at limit ~50 (not the 30 on-screen). Deeper, reranked, actually uses the engine.
- **Richer format + higher caps + stop over-dropping** (details below).
- **Chat parity:** stronger model, higher default search limit, encourage multiple searches, fuller answers.

## Root causes (why it underdelivers today)
1. Digest never queries the Worker — it clusters `visiblePosts.slice(0,30)` (the current screen). Powerful search unused.
2. Weakest model tier (nano) does all synthesis/clustering.
3. Prompt tells it to use 2–6 themes, "prefer fewer," and "drop off-topic" → short output.
4. Thin format: themes + 8–14-word gists + ONE overall sentence; barely uses the full article bodies now available.

## Task plan

### T1 — Digest engine (schema + prompt + API + deeper sourcing)
- `app/api/digest/route.ts`: model → `google/gemini-3.6-flash`; adapt providerOptions for Gemini; keep the passkey gate + streaming.
- `lib/digest-schema.ts` — new richer output contract (raise input cap, e.g. sources max 60 kept; we send ~50):
  - `tldr`: 2–3 sentence synthesis of what the saved posts COLLECTIVELY say about the query (the headline value — not "where to start").
  - `themes`: up to ~8, each `{ title, summary (2–3 sentences), sources: [{ bookmarkId, author, gist, url }] }` — include ALL relevant sources per theme, not a sample.
  - `readFirst`: 3–5 top picks `{ bookmarkId, author, why, url }` — the highest-signal starting points.
  - `deeperReads` (optional): article bookmarks `{ bookmarkId, articleTitle, author, why, url }` surfaced from the article excerpts.
- `lib/digest-prompt.ts` — rewrite (EN + HU) for the new format: synthesize the TL;DR; "include everything relevant, only drop true noise (do NOT aggressively prune)"; use `articleExcerpt` for real synthesis; produce readFirst + deeperReads. Keep verbatim-id/url copying rules.
- Client sourcing (`components/bookmarks-app.tsx` digest CTA, ~line 816): before opening the digest, `searchViaWorker({ query, precision, limit: 50 })` → map ranked ids → posts (via `postsById`) → `toDigestSource` → send up to 50. Fall back to `visiblePosts.slice(0,50)` if the re-query fails/empties. Keep the "regenerate" path consistent.
- `lib/digest-source.ts`: consider a longer excerpt for richer synthesis (currently 500) — optional, don't bloat the prompt unreasonably.
- Verify: a real `/api/digest` call (curl with the digest_unlock cookie + OPENROUTER_API_KEY from .env.local) streams the new schema for a sample query; EN + HU both produce valid structured output with gemini-3.6-flash.

### T2 — Digest UI (render + cache) — consumes T1's schema
- `components/digest-panel.tsx`: render the new format — TL;DR block up top, Themes (with more sources), "Read first", "Deeper reads"; update the streaming partial-object handling + sanitization for the new fields.
- `lib/digest-cache.ts`: `SavedDigest` gains `tldr`/`readFirst`/`deeperReads`; BACKWARD-COMPAT with old saved digests (old shape = themes+overall only → render gracefully, no crash).
- `components/saved-digests-panel.tsx`: reflect the new shape in the saved list.
- `lib/i18n.ts`: new section labels (TL;DR / Read first / Deeper reads / Themes), EN + HU.
- Verify: `npm run build` green; a live digest renders the new sections; an OLD cached digest still opens without error.

### T3 — Chat improvements (independent of T1/T2's schema; sequence to avoid bookmarks-app.tsx conflicts)
- `app/api/chat/route.ts`: model → `google/gemini-3.6-flash`; adapt providerOptions (Gemini reasoning) ; keep stepCountIs.
- `lib/chat-tools.ts`: raise `search_bookmarks` default `limit` 20 → ~35 (max stays 60).
- `lib/chat-prompt.ts`: encourage MULTIPLE searches for broad questions, fuller answers with MORE citations, relax the hard "2–6 sentences" cap to "as long as needed, well-structured, cite sources." Keep the "don't fabricate / cite real ids+urls" rules. EN + HU.
- `components/bookmarks-app.tsx` `runChatSearch`: confirm it passes the tool's `limit` through to the Worker path (currently slices `pool.slice(0, input.limit)` — make sure a higher limit actually returns more).
- Verify: `npm run build` green; ⌘K chat answers a broad question by searching + citing several sources.

## Constraints
- `NEXT_PUBLIC_SEARCH_ENDPOINT` / the Worker are unchanged; this is client + Vercel /api/* only. Ships via Vercel merge (no Worker redeploy needed).
- Passkey gate on /api/digest + /api/chat unchanged; OPENROUTER_API_KEY server-side only.
- Keep EN + HU parity on every prompt/label.
- TS strict; `npm run build` + tests green.

## Rollout
All on `digest-upgrade`; sequence T1 → T2 → T3 (T2 needs T1's schema; T1/T3 both touch bookmarks-app.tsx so serialize). Whole-branch check, then merge → Vercel. No Worker redeploy, no token needed.
