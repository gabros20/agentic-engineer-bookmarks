# Cloudflare Server-Side Search Refactor

Move all ML search inference off the client and into a Cloudflare Worker backed by Workers AI, so search is identical, high-quality, and non-freezing on **every** device (mobile = desktop), with no 135 MB model download and no main-thread inference.

**Status:** planned · **Branch:** `cloudflare-search` · **Supersedes:** the client Web Worker idea (never built)

---

## Why this shape

The freeze is caused by ML inference running on the browser's main thread; the mobile-data/memory cost is caused by shipping 135 MB of models to every device. Moving inference **server-side** fixes both at once and deletes the client-inference code entirely. Cloudflare Workers AI is the fit: GPU inference, a **multilingual embedder** (`@cf/baai/bge-m3`) *and* a real **cross-encoder reranker** (`@cf/baai/bge-reranker-base`), on a free tier that covers this site with huge margin.

### Cost check (Workers AI free tier = 10,000 neurons/day)
- One-time corpus re-embed (~6,840 chunks, bge-m3): **~6,850 neurons** — fits in a single day's free allowance.
- Per search: query embed (negligible) + rerank 50 passages ≈ **~5 neurons** → **~2,000 searches/day free**. Effectively free forever at personal scale.

## Architecture

```
Browser (Vercel app)                 Cloudflare Worker (workers.dev)         Workers AI (GPU)
─────────────────────                ───────────────────────────────        ────────────────
type query ──► fetch /search ───────► load bge vectors + lunr index          @cf/baai/bge-m3
  (debounced)   {query,precision,       (cold-start, cached in isolate)         (query embed)
                 filter,limit,rewrites} keyword search (lunr)          ◄──────  @cf/baai/bge-reranker-base
render ranked  ◄── ranked ids ────────  + vector search (dot product)           (rerank top-50)
  from local posts                      + RRF merge + floors + rerank blend
```

- **Client** sends the query string, receives ranked bookmark ids, renders from the posts it already holds (13 MB, unchanged from today). **No model download, no vector download, no local inference — on any device.**
- **Worker** owns the whole hybrid pipeline. Reuses the *same* merge/floor/blend algorithm as today (ported); only the model calls change (transformers.js → Workers AI bindings).
- **Vector + keyword data**: `search-index-bge.json` (bge-m3 doc vectors, int8, 1024-dim) + a serialized lunr index. v1 hosts both as static files the Worker fetches on cold start and caches in isolate memory (no KV/R2/Vectorize needed — simplest, least manual). Hardening option later: move to Cloudflare R2/KV.
- **Rate-limiting**: the `/search` endpoint is public (search serves all visitors), so it needs a light limiter to protect the free tier — Cloudflare's built-in rate-limiting rule (wrangler-configurable) keyed on IP.

## Model change → quality MUST be re-validated

Swapping `multilingual-e5-small` → `bge-m3` and `ms-marco-MiniLM` → `bge-reranker-base` changes score distributions. Consequences:
- The corpus must be **re-embedded** with bge-m3 (query and doc vectors must come from the same model).
- The broad-mode **floors** (`0.82` cosine / `0.50` relative, calibrated for e5) **must be recalibrated** for bge-m3.
- The eval harness must run against the new stack and confirm recall@10 / mrr@10 / ndcg@10 hold at or above the current e5 numbers (recall@10 0.615 / mrr 0.492 / ndcg 0.500) before cutover. No cutover on a regression.

## Task plan (for /orchestrate, opus subagents, staged + dual review)

**T0 — Spike (AUTH-BLOCKED).** Minimal Worker; call bge-m3 + bge-reranker via `wrangler dev`; confirm: exact I/O shapes, embedding dims (expect 1024), whether bge-m3 returns normalized vectors, reranker output shape (`{index,score}` order), and score ranges on a few real (query, passage) pairs. Findings pin the contracts for every later task. ~1 hr once authed.

**T1 — Re-embed corpus with bge-m3 (AUTH-BLOCKED for the run).** `scripts/embed-bge.mjs`: run all 6,840 chunks through Workers AI bge-m3 (REST or a temp Worker route), write `public/data/search-index-bge.json` (int8, 1024-dim, same `{id,part?}` chunk structure as today). Idempotent, resumable. Also emit `public/data/lunr-index.json` (serialized lunr keyword index) for the Worker. Code can be written pre-auth; the run needs auth.

**T2 — The Worker (`worker/`).** `wrangler.jsonc` with the `ai` binding; `src/index.ts`: on cold start fetch+cache bge vectors + lunr index; per request run keyword + query-embed (bge-m3) + vector search + RRF merge + floors + rerank (bge-reranker) + blend → ranked ids. Port the pure merge/floor/blend logic from `lib/bookmark-search.ts` + `lib/rerank.ts` (shared, not re-invented). CORS for the Vercel origin. Request/response contract defined in T0.

**T3 — Recalibrate floors + bge eval (AUTH-BLOCKED for the run).** Adapt the eval harness to score against the Worker (or CF AI) over the golden queries; sweep + set bge floors; confirm metrics ≥ current e5 baseline. Gate: no cutover on regression.

**T4 — Client refactor.** Delete client-side inference: `embedQueries`, `multiVectorSearch`/`vectorSearch` calls, `rerankResults`/`lib/rerank.ts` usage, model warmup, the model-download progress store, and the `@huggingface/transformers` dependency from the client bundle. Replace the search effect with a debounced `fetch(SEARCH_ENDPOINT, ...)`; keep operators (`from:`/date), sort-within-results, and the `/api/expand` LLM rewrites (pass rewrites to the Worker or drop — decide in T0). `runChatSearch` calls the Worker too. Loading state = spinner during the fetch (network wait, never a freeze). Offline/failure fallback = cheap client substring filter over already-loaded posts (no lunr build).

**T5 — Deploy + wire + verify (SOME MANUAL).** `wrangler deploy`; set the Worker URL as a Vercel env var (`NEXT_PUBLIC_SEARCH_ENDPOINT`); configure the rate-limit rule; browser-verify on desktop **and** mobile: no freeze, no big download, quality parity, ranked results correct. Then merge → push (Vercel deploys the client; Worker already live).

## Manual-only steps (everything else is CLI / code)

1. **Cloudflare auth (BLOCKS T0/T1/T3/T5 runtime).** `npx wrangler login` interactively, or set `CLOUDFLARE_API_TOKEN` (scopes: Workers AI + Workers Scripts). Current stored login is expired.
2. **workers.dev subdomain** — first `wrangler deploy` may prompt to register a free `*.workers.dev` subdomain (one-time; CLI prompt or a dashboard click).
3. **Vercel env var** — `NEXT_PUBLIC_SEARCH_ENDPOINT` = the Worker URL (I can do this via `vercel env` if the Vercel CLI is authed, else manual).
4. **Rate-limit rule** — created via wrangler config where possible; may need a dashboard toggle depending on plan.
5. (Optional hardening) enabling **R2/KV** if we move the vector/lunr files off public static hosting — not needed for v1.

Free-tier reliance: Workers AI free is 10k neurons/day; note that exceeding it (or running `wrangler dev` against the account) bills real usage. At this site's scale that won't happen, but it's your account paying if it does.

## Rollout / safety

- All work on `cloudflare-search`; the current all-local search on `main` keeps working untouched until T5 cutover.
- Cutover gate: bge eval ≥ e5 baseline AND browser smoke passes on mobile+desktop.
- The Worker deploys independently of the Vercel app; the client change is the only thing that ships via `git push`.
- Kept as a documented fallback if bge quality disappoints: keep e5 client path behind a flag (not default). Decide at T3.
