# Post-cutover follow-ups plan

The Cloudflare server-side search shipped (main @ d120c19). Three follow-ups from that work, now scoped for execution.

**Branch:** `search-followups` · **Strategy:** /orchestrate staged, sonnet workers, dual review · Ships in two waves (Vercel merge for client/docs; one Worker redeploy for ranking/data).

---

## What ships where (important)
- The deployed Worker (`bookmark-search.t-gabor880312.workers.dev`) fetches its data from Vercel `/data` and **caches it per isolate**. So:
  - Client/docs changes (T1) ship via merge → Vercel rebuild.
  - Worker ranking changes (T2) + refreshed data (T3) only reach prod after a **`wrangler deploy`** (forces fresh isolates that re-fetch data). That deploy needs the Cloudflare token — a final gated step (T4).

## T1 — Copy + docs accuracy (client + README) · low risk, ships via Vercel
Search is no longer "local/browser-side" — fix the now-false claims.
- `lib/i18n.ts`: `app.subtitle` "{n} saved posts searchable locally" → server-side-accurate wording (EN + HU); scan for any other stale search-copy status keys.
- `README.md`: rewrite the search-architecture claims — the Features bullet (Transformers.js/Lunr/ms-marco "browser-side"), the "fully local/browser-side" line (58), the "query embeddings run in the browser, no database" note (142), the API-only-for-AI note (144). Describe the real architecture: hybrid search (lunr keyword + bge-m3 semantic + bge-reranker) runs on a **Cloudflare Worker** (Workers AI, free tier); the client ships no ML; data (bge index + lunr + rerank-docs) served from Vercel static and fetched by the Worker. Update the Stack section (drop the client Transformers.js framing) and add a short "Search architecture" subsection + the Worker deploy/sync notes.
- Acceptance: no remaining "searchable locally"/"runs in the browser"/"browser-side" search claims; README matches the shipped architecture; `npm run build` green.

## T2 — Handle-class recall recovery · eval-gated, ships via Worker redeploy
Bare single-token `@handle` exact queries regressed (recall@10 0.25 vs e5 0.67) because bge-hybrid's keyword+vector surfaces author posts weaker than e5 did, and (measured) the reranker HELPS handle so it must stay. Lever to try: strengthen the keyword/exact-author signal for **bare single-token exact queries only**.
- Approach (in `lib/bookmark-search.ts` `runHybridPipeline`, keyed so the e5 path stays byte-identical and only the bge/worker path changes): for exact precision + single-token query, raise the keyword RRF weight (and/or add an exact author-screenName match boost) so keyword-matched author posts survive into the rerank window and top-10. Do NOT touch multi-token exact (titles/phrases at 1.0) or broad.
- MEASURE with the bge gate (`scripts/eval-bge.mjs`, driven against a local `wrangler dev` + data server): handle recall must rise materially toward e5's 0.67 with NO regression on any other class vs the current committed bge baseline (recall .625/mrr .520/ndcg .534).
- Honest-failure escape: if no keyword-weight setting recovers handle without regressing others, REVERT and report — the current state already beats e5 overall; a partial/again-failed fix is not worth shipping a regression. This task may legitimately end "no improvement found; left as-is."
- Acceptance: eval table shows handle up + others not down, OR an honest "reverted, no safe gain." `wrangler check startup` still passes.

## T3 — Sync pipeline integration (bge data stays fresh) · ships via Worker redeploy
`npm run sync` still runs the OLD e5 `embed-new.mjs`; future bookmark syncs never update the bge index/lunr/rerank the Worker serves. Wire the bge pipeline in and fix the T1-review findings.
- New sync chain: `xrelay archive bookmarks → backfill-articles → embed-bge (INCREMENTAL) → build-lunr-index → build-rerank-docs → pack-bge-index`. Replace `embed-new.mjs` (e5) in the `sync` script.
- **embed-bge incremental + F1 fix:** it already resumes by (id,part); make it a true incremental top-up (embed only new/changed items) AND fix F1 — a backfilled/edited article whose id was already embedded leaves its MAIN vector stale (searchText now includes the article body). Detect content change per (id,part) (e.g. a stored short content hash) and re-embed changed items, not just missing ones.
- **wrangler-dev requirement:** embed-bge needs the Worker `/embed` route (Workers AI) via `wrangler dev`. The sync must start/stop `wrangler dev` (worker/) around the embed step (or clearly document a two-command flow). Prefer automation: script spins up wrangler dev, waits for ready, runs the embed against localhost, tears down. Keep the EMBED_SECRET gate (dev-only) working.
- **F2 drift guard (cheap):** add a lightweight check/test that `build-lunr-index.mjs` / `build-rerank-docs.mjs` still match lib's buildKeywordIndex / buildRerankDocText config (or at least a comment + a `test:search`-style assertion), so silent drift is caught.
- **Worker data refresh:** after a sync rebuilds+commits the data, the deployed Worker still serves cached data until redeployed. Document a `npm run deploy:worker` (wrangler deploy) as the post-sync step to refresh prod, and note it in the README sync section. (Do NOT try to auto-deploy from the sync — needs the token; keep it an explicit step.)
- Acceptance: `npm run sync` produces a consistent, aligned set of bge artifacts (index/lunr/rerank all covering the same post set); a dry-run on the current data is a near no-op (nothing new) and does NOT corrupt the committed files; the F1 staleness case is handled (a re-run after an article backfill re-embeds that main vector). README sync section updated.

## T4 — Deploy the changes (GATED on the Cloudflare token) · controller + user
After T1–T3 are reviewed clean and merged to main:
1. `wrangler deploy` the Worker (ships T2 ranking; picks up any T3-refreshed data) — needs `CLOUDFLARE_API_TOKEN`.
2. Merge → Vercel rebuild ships T1 copy/docs + serves any refreshed data.
3. Verify prod: handle query behaves better (if T2 landed a gain); a sync dry-run is clean; copy is correct.

## Out of scope (explicitly)
- R2 migration for the data (optional hardening; current Vercel-static hosting works fine). Note only.
- Any change to the digest/chat OpenRouter features.

## Rollout / safety
- All work on `search-followups`; main stays shippable. T2/T3 touch lib/worker/scripts but the e5 client path is gone from prod, so the only "client" risk is T1 copy.
- T2 is eval-gated and reverts on no-gain. T3's acceptance requires a non-destructive dry-run on current data.
- Nothing reaches prod until T4's explicit deploy/merge.
