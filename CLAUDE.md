# CLAUDE.md — project guide

Next.js 16 app for browsing a personal X bookmark archive. Search + AI features are the heart of it.

## Architecture (one screen)
- **Search runs server-side on a Cloudflare Worker** (`worker/`, `bookmark-search.*.workers.dev`): lunr keyword ⊕ `@cf/baai/bge-m3` semantic ⊕ `@cf/baai/bge-reranker-base` rerank. The **client ships zero ML** and just fetches ranked ids from the Worker (`lib/search-client.ts`).
- **Data** = static JSON in `public/data/` (bge `.bin`+`.meta.json`, `lunr-index.json`, `rerank-docs.json`), served by Vercel and fetched by the Worker (cached per isolate).
- **AI Digest + ⌘K chat** = Vercel `/api/digest` + `/api/chat`, passkey-gated (`DIGEST_UNLOCK_SECRET` cookie), model `google/gemini-3.6-flash` via OpenRouter. The digest re-queries the Worker for ~50 sources.
- **Ranking math is single-sourced** in `lib/bookmark-search.ts` + `lib/rerank-core.ts`, reused by the client, the Worker (bundled via `@/` aliases in `worker/wrangler.jsonc`), and the eval harness. Model-specific behavior is **gated on the index `model`/`prefix_scheme`** so the legacy e5 path stays byte-identical.

## Operational rules (don't get burned)
- **Two deploy targets.** `git push` → Vercel (app + `/data`). The **Worker does NOT update on a push** — run **`npm run deploy:worker`** after any data or Worker/ranking change. See `docs/SYNC-AND-DEPLOY.md`.
- **Cloudflare auth is per session; no token is committed** (`worker/.env` deliberately absent). Use `wrangler login` or `export CLOUDFLARE_API_TOKEN=...` before a sync-that-embeds or a deploy. `scripts/sync-bge.mjs` fails fast with instructions if it's missing.
- **`NEXT_PUBLIC_SEARCH_ENDPOINT` is build-time inlined** — must be set in Vercel before a build.
- **Ranking changes are eval-gated:** `npm run eval:bge` (needs a running worker/data server) vs `scripts/eval-baseline-bge.json`; never ship a per-class regression. `npm run test:search` + `npm run test:operators` must stay green.
- **bge-m3 input hygiene** (empty/oversized/lone-surrogate → errors) is handled in `scripts/embed-bge.mjs` — keep it when touching the embed path.

## Docs
- `docs/SYNC-AND-DEPLOY.md` — the sync → push → deploy:worker runbook + auth + troubleshooting.
- `docs/ENGINEERING-NOTES.md` — architecture, verified API contracts (Workers AI / wrangler / Vercel / OpenRouter), decision log, and the problem→solution→validation history. **Read this before non-trivial search/AI work.**
- `docs/{CLOUDFLARE-SEARCH,FOLLOWUPS,DIGEST-UPGRADE}-PLAN.md` — per-effort plans.
