# Engineering notes — search stack + AI features

A durable, reuse-oriented record of the technical findings, decisions, and problem→solution→validation
chains from building this app's search + AI layer. Written so a future session (human or agent) can
reuse the reasoning without re-deriving it. Skim the tables; read the P→S→V log when debugging something similar.

Scope of the work captured here:
1. **In-browser search upgrade** (MiniLM→e5, chunked article vectors, lunr hybrid, floors, rerank, operators).
2. **Server-side search migration** to a Cloudflare Worker (bge-m3 + bge-reranker) — killed the typing freeze + 135 MB mobile download.
3. **Post-cutover follow-ups** — handle-recall recovery, sync-pipeline integration, docs.
4. **AI Digest + chat upgrade** — gemini-3.6-flash, deeper Worker sourcing, research-brief format.

---

## 1. Final architecture (quick reference)

```
Browser (Vercel static, ML-FREE)          Vercel /api (session-gated)          Cloudflare Worker / Workers AI
────────────────────────────────          ───────────────────────────          ─────────────────────────────
type query ─► lib/search-client.ts ──────► /api/search (session + quota) ──────► worker/src/index.ts /search
  (debounced, AbortController+timeout)       fail-closed X-Proxy-Secret          keyword (lunr) ⊕ bge-m3 ⊕ rerank
render ranked ids from local posts                                              data from Vercel /data, per-isolate cache
                                                                                @cf/baai/bge-m3 + bge-reranker-base
AI Digest / ⌘K chat ──► /api/digest,        session-gated + per-user daily
  /api/chat, /api/expand                     quota (lib/api-guard.ts) ──────────► deepseek-v4.1-flash-1017 (OpenRouter)
  digest re-queries the Worker at ~50        digests + chats persist to Neon (user-scoped, cross-device)
```

All routes require a Better Auth session (401 otherwise). The Worker is no longer publicly reachable —
only `/api/search` (holding `SEARCH_PROXY_SECRET`) can call it. See §8 for the auth/DB layer.

- **Client ships zero ML** (no transformers.js/onnx/lunr in the bundle). It sends the query to the Worker and renders `{id,score}`.
- **Worker** owns the whole hybrid pipeline; reuses the *same* ranking math as the (now-removed) client path via `lib/bookmark-search.ts` + `lib/rerank-core.ts` bundled into the Worker.
- **Data** = static JSON in `public/data/`, served by Vercel's CDN and fetched by the Worker (no R2 needed; R2 is an optional future swap).
- **Deploy split:** client/docs ship via `git push` → Vercel; **Worker ranking/data changes need `npm run deploy:worker` (wrangler deploy)** — a Vercel push alone does NOT reach Cloudflare.

Live: worker `bookmark-search.t-gabor880312.workers.dev`, app `agentic-engineer-bookmarks.vercel.app`.

---

## 2. Decision log (the "why")

| Decision | Chosen | Rejected (and why) |
|---|---|---|
| Fix the typing freeze | Move ML off the main thread | Freeze = ML on the **main thread**, not that it's local. A Web Worker or server both free the thread. |
| Where to run inference | **Cloudflare Worker (server-side)** | *Client Web Worker*: keeps 135 MB download + iOS memory risk → unequal mobile. *"Just use OpenRouter"*: OpenRouter has embeddings but **no reranker** endpoint, and rerank dominates the freeze. |
| Embedding backend | **Cloudflare Workers AI** (GPU, free 10k neurons/day) | OpenRouter (no rerank); HF Inference (free tier only $0.10/mo); Vercel function running transformers.js (CPU cold-start + slow rerank). |
| Embedding model | `@cf/baai/bge-m3` (multilingual, 1024-dim) | bge-small-en (English-only); had to re-embed corpus anyway (query+doc vectors must be same model). |
| Vector store | Ship packed int8 `.bin` on Vercel, Worker fetches + dot-products in-memory | Vectorize free tier (5M stored dims) too small for 6,840×1024=7M dims; not worth it for a brute-force scan over ~7k vectors. |
| Semantic-only vs hybrid | **Keyword+semantic hybrid** (restored after eval FAIL) | Semantic-only lost handle (0.08) + article-title classes — see P→S→V #3. |
| Digest/chat model | `deepseek/deepseek-v4.1-flash-1017` (2026-10-28; was `google/gemini-3.6-flash`) | The original objection to open-weight models — weaker **Hungarian** + **strict streamed structured output / tool-calling** — was re-tested live on 2026-10-28 through the real `streamObject`/`streamText` paths: valid `digestSchema` in EN + HU (34/34 cited ids real), a 10-step tool loop, fluent HU. ~5x cheaper ($0.15/$0.60 vs $0.75/$3.75 per M) and faster (digest 10s vs 24s). Revert = one `MODEL` constant per route. |
| Digest sourcing | Re-query the Worker at limit ~50 | Clustering the 30 on-screen results left the great search engine unused. |

Guiding principle that recurred: **keep the pure ranking logic single-sourced** (`lib/bookmark-search.ts`,
`lib/rerank-core.ts`) and reused by client, Worker, and the eval harness, with model-specific behavior
**gated on the index's `model`/`prefix_scheme`** so the e5 code path stays byte-identical and the eval
baseline never silently shifts.

---

## 3. Hard technical contracts (empirically verified)

### Workers AI — `@cf/baai/bge-m3` (embeddings)
- Call: `env.AI.run("@cf/baai/bge-m3", { text: string|string[], truncate_inputs: true })` → `{ data: number[][], shape:[n,1024] }`.
- **1024-dim, L2-normalized** (norm ≈ 1.0) → dot product == cosine, no re-normalize.
- **No e5-style prefixes** — embed RAW text (bge is prefix-free; unlike e5 which needs `query:`/`passage:`).
- **Input hygiene is mandatory** (the endpoint errors where transformers.js silently coped):
  - empty/whitespace-only text → `3030 invalid input` → fall back to a non-empty placeholder (`text || post.id`).
  - oversized single text → `3030` → pass `truncate_inputs: true` AND belt-and-suspenders cap (~6000 chars).
  - **lone/unpaired UTF-16 surrogates** in some tweets → `3030`/`3043` → strip them (keep valid emoji pairs).
  - intermittent transient `3030` on valid text → retry-with-jitter + a multi-pass loop; make single-item failure **non-fatal** (placeholder) so a batch job always completes.

### Workers AI — `@cf/baai/bge-reranker-base` (rerank)
- Call: `env.AI.run("@cf/baai/bge-reranker-base", { query, contexts:[{text}], top_k? })` → `{ response:[{id:<orig index>, score:0..1}] }` **sorted desc**. Map `id` (the context index) back to the doc.
- Scores are sigmoid [0,1], sharply separated (relevant ~0.9 vs ~0.00004). Already normalized.
- **~0.017 neurons per 3-context rerank** → a 50-context rerank is well under 1 neuron. Free tier (10k neurons/day) is effectively unlimited here (~2,000 searches/day headroom; the one-time corpus re-embed was ~6,850 neurons).

### Wrangler / Cloudflare auth (a real time-sink)
- OAuth `wrangler login` was flaky: it let `wrangler dev` run in some shells but **failed `deploy`/`r2`/`whoami` non-interactively** ("set CLOUDFLARE_API_TOKEN").
- **Reliable fix: a gitignored `worker/.env` with `CLOUDFLARE_API_TOKEN=...`** — wrangler reads it automatically. Unblocks dev + deploy for subagents/CI. (Create token: dashboard → API Tokens → "Edit Cloudflare Workers" + Workers AI.)
- `wrangler dev` runs Workers AI **remotely** (bills the account) even locally. `wrangler check startup` measures cold-start CPU. First deploy may prompt to register a `*.workers.dev` subdomain.

### Cloudflare Worker runtime
- 128 MB memory; a startup CPU-time limit. **Load big data LAZILY (first request), not at module top-level** — keeps startup ~1 ms even with a 13 MB lunr index + 7 MB vectors.
- **Load-once caching pattern:** a module-scope `dataPromise` guarded so concurrent requests share one load — **but reset it to `null` on rejection**, else one transient load failure permanently poisons the isolate (every later request 500s until eviction). Same pattern for lazily-loaded models.
- Vectors: store as a compact **int8 `.bin`** (row-major) + a small `.meta.json` (ids/parts in row order). Read the `.bin` as an `Int8Array` and take zero-copy `subarray` views — no per-request `number[]` materialization.
- Data source is swappable via one abstraction: `DATA_BASE_URL` (HTTP fetch from Vercel CDN) in prod, or an R2 binding if added later (`loadData()` prefers R2 when bound).
- **The deployed Worker caches data per isolate → refreshing data requires a redeploy** (`npm run deploy:worker`).
- Gate any billable route (e.g. a dev-only `/embed`) behind a secret; keep `/search` public with pinned CORS (`ALLOWED_ORIGINS`).

### Vercel
- **`NEXT_PUBLIC_*` env is inlined at BUILD time** — must be set in the Vercel project *before* the build, or prod ships the fallback (we nearly shipped search pointing at `localhost`).
- Fluid Compute allows `maxDuration` up to 300 s (default 300). Bumped `/api/digest` to 120 s for the ~50-source gemini generation.
- A `git push` to `main` deploys the Vercel app + serves new `/data`, but does **not** touch the Cloudflare Worker.

### OpenRouter models (surveyed 2026-07, prices $/M in/out)
- `google/gemini-3.6-flash` 1.50/7.50 · `gemini-3.5-flash` 1.50/9 · `gemini-3.1-flash-lite` 0.25/1.50 · `gemini-2.5-flash-lite` 0.10/0.40
- `openai/gpt-5.4-nano` 0.20/1.25 (old) · `gpt-5.4-mini` 0.75/4.50 · `gpt-5.4` 2.50/15
- `qwen/qwen3.5-flash` 0.07/0.26 · `deepseek/deepseek-v3.2` 0.27/0.40 · `z-ai/glm-4.7-flash` 0.06/0.40 (cheap+smart, but HU + strict-schema/tool reliability are the risk for this app).
- `reasoning.effort` in `providerOptions.openrouter` is **OpenRouter's provider-agnostic** field (maps to Gemini's thinkingLevel) — NOT OpenAI-only. Don't drop it thinking it's OpenAI-specific; it caps interactive-route latency.
- A digest (~50 sources ≈ 10-15k in + 2-4k out) on gemini-3.6-flash ≈ ~$0.05. Cost is not the binding constraint on occasional AI features.

---

## 4. Problem → solution → validation log

**P1. macOS TCC blocked the whole project dir.** Mid-session, every tool got "Operation not permitted" on `~/Documents/...`; `~`, `~/Desktop`, `~/.claude` were fine. → Cause: macOS Documents-folder privacy (TCC) revoked for the terminal. → Fix: user re-granted Files-and-Folders / restarted the terminal. **Validation:** `ls ~/Documents` OK again. *Lesson: EPERM (not EACCES) on a `~/Documents` subtree with metadata still readable = TCC, not chmod.*

**P2. bge-m3 re-embed failed 4× before completing.** → empty text (`3030`) → `text||id`; a 15 000-char article main-vector (`3030`) → `truncate_inputs:true` + 6000-char cap; **lone UTF-16 surrogates** in one post (`3030`/`3043`) → strip unpaired surrogates; transient `3030` bursts → retry-jitter + multi-pass + **non-fatal single-item placeholder**. **Validation:** full corpus embedded (6,840 vectors, exact id/part parity with the e5 index, L2≈1 after de-quant). *Lesson: a hosted embedding endpoint enforces input limits transformers.js swallowed — sanitize (empty/oversized/surrogates) at the source; the fix is now baked into `scripts/embed-bge.mjs` for every future sync.*

**P3. The eval gate FAILED — and that was the system working.** Semantic-only bge (recall .557) lost **handle 0.25 vs e5 0.67** and **article-title 0.75 vs 1.0** — the keyword-dependent classes — while WINNING hu-topic (+0.10) and paraphrase (+0.25). → Root cause: T2 dropped keyword to lean-start. → Fix: restore the lunr hybrid in the Worker (the serialized index was already built). **Validation (T3b):** bge-hybrid **beats e5 on all three** (recall .625/mrr .520/ndcg .534), article-title back to 1.0, semantic wins kept. *Lesson: the golden-query gate caught a real regression BEFORE cutover; never cut over on a per-class regression even when the average improves.*

**P4. Handle class still lagged (0.25 vs 0.67) after the hybrid.** → Experiment 1: *skip rerank for bare handles* — measured **worse** (0.167); the reranker actually HELPS handle. Reverted. → Experiment 2: *keyword-dominant RRF weight for bare single-token exact queries* — measured handle **0.833** (beats e5). → Review flagged: it fires for ANY one-word Exact query (Exact is the default), and `1.0/0.0` zeroes semantic for one-word topic queries → **tuned to 0.85/0.15**. **Validation:** handle **0.75** (still > e5 0.667), overall recall **.688/.537/.565** (all > e5), semantic retained for topic words; verified live on prod ("rauchg" → @rauchg's posts top). *Lesson: measure each hypothesis; the obvious lever (skip rerank) was wrong; retain a semantic sliver rather than a knife-edge weight.*

**P5. Reviews caught bugs the implementers' own live tests missed.** (a) Chat `limit` pass-through **starved the client-side article/media filter** (35 candidates instead of the Worker's 240) — the implementer's `filter:"all"` smoke looked fine; review traced the filtered path → reverted. (b) Worker `dataPromise` **reject-memoization** poisoned isolates → reset-on-reject + live recovery test. (c) Dropping `reasoning.effort` on a *wrong premise* (thought OpenAI-only) uncapped interactive-chat latency → restored "medium". *Lesson: dual review (spec→quality) with an adversarial "rule out the regression the brief named" prompt earns its cost; a green happy-path smoke ≠ correct.*

**P6. Non-destructive sync.** Wiring the bge chain into `npm run sync` risked corrupting committed artifacts. → Gate: a sync on current data must be a clean no-op. **Validation:** dry-run embedded 0/changed 0, `git diff --stat public/data/` clean; F1 (backfilled-article stale main vector) fixed via a per-item content fingerprint and simulated. *Lesson: for any "rebuild in place" pipeline, make "no new input → byte-identical output" an explicit, tested acceptance criterion.*

---

## 5. Methodologies worth reusing

- **Spike first.** Before building against any external API, probe its real I/O empirically (a throwaway `wrangler dev` worker returning raw shapes). The bge/reranker contracts in §3 came from a 20-minute spike and pinned every later task. Saved rework.
- **Eval-gated ranking changes.** Golden queries (`scripts/eval-queries.json`, ~30 across en/hu/handle/article-title/phrase/paraphrase), metrics recall@10/mrr@10/ndcg@10 per class, a committed baseline, and a hard rule: **no ship on a regression; honest-revert is a valid outcome.** This is what made the migration trustworthy.
- **Floor calibration by grid sweep.** Broad-mode relevance floors (drop low-cos tail) were chosen by sweeping abs-cosine × relative-floor and picking the recall-preserving cell with the smallest tail — never guessed. bge cosines top ~0.67, so e5's 0.82 floor would have zeroed everything (model-specific calibration is mandatory).
- **Model-gate cross-cutting changes** so the old path stays byte-identical (e5 vs bge keyed on index `model`/`prefix_scheme`) — keeps the eval baseline valid and makes rollback trivial.
- **Orchestrate staged** (fresh implementer per task + spec→quality dual review). Reviews consistently found real Important issues the implementer's own tests missed (P5). Keep the review prompt adversarial and name the specific regression to rule out.
- **Verify the deliverable live**, not just tests — every model swap was confirmed streaming valid output (EN+HU) before trusting it; the freeze fix + digest format were confirmed in a real browser on prod.

## 6. Gotchas checklist (bit us or nearly did)

- [ ] All secrets are server-only — **no `NEXT_PUBLIC_*`** (Worker URL + `SEARCH_PROXY_SECRET` included). Set the server env vars in Vercel **before the build**.
- [ ] A Vercel push does NOT update the Cloudflare Worker → run `npm run deploy:worker` after data/ranking changes — and it must go live **together** with the app merge now (secret-gated Worker).
- [ ] neon-http has **no `db.transaction()`** → use `db.batch([...])` for multi-statement atomicity.
- [ ] Worker isolates cache data → same redeploy requirement; a load-promise must reset on rejection.
- [ ] bge-m3 rejects empty/oversized/lone-surrogate input → sanitize at the source.
- [ ] wrangler OAuth ≠ token; non-interactive commands want `CLOUDFLARE_API_TOKEN` (gitignored `worker/.env`).
- [ ] `reasoning.effort` is OpenRouter-unified, not OpenAI-only.
- [ ] Chinese/open-weight LLMs: weaker Hungarian + strict-schema/tool reliability — A/B before trusting for HU structured features.
- [ ] Client-side filters after a search need the search to return a *generous* candidate set, not a tight limit (filter-starvation).
- [ ] macOS: `rm` may be aliased to `trash` (ignores `-f`) — use `/bin/rm` in scripts; `~/Documents` is TCC-protected.

## 7. Metrics + known limitations

**Search quality journey (recall@10 / mrr@10 / ndcg@10):**
- MiniLM (original): .411 / .380 / .348
- e5 v2 + lunr + floors + rerank (in-browser final): .615 / .493 / .501
- bge-hybrid on the Worker (shipped): **.688 / .537 / .565** — beats every prior stack; hu-topic and paraphrase notably up.

**Known limitations / optional follow-ups:**
- Data lives on Vercel static + Worker-fetched; **R2 is an optional hardening** (loadData already supports the binding).
- Handle recall (0.75) is great but the `from:handle` operator is still the exact way to list one author.
- The whole app is now behind login (see §8); the digest passkey is retired. `DIGEST_UNLOCK_SECRET` survives only as the seed invite code. Per-user daily quotas (search 300 / digest 10 / chat 40) bound the OpenRouter/Workers-AI cost.
- Plan docs for each effort: `docs/{SEARCH-UPGRADE,CLOUDFLARE-SEARCH,FOLLOWUPS,DIGEST-UPGRADE,AUTH-DB}-PLAN.md`.

---

## 8. Auth + DB layer (invite-gated accounts, sessions, quotas, persistence)

Added after the search/AI stack to make the app **private, invite-only, and account-based**, with
per-user history that syncs across devices. The search/ranking math above is untouched — this layer wraps
it in auth + a proxy.

### Stack
- **Neon Postgres** via **Drizzle ORM** (`lib/db/`), **neon-http** driver. Schema in `lib/db/schema.ts`; migrations in `drizzle/` (`db:generate` / `db:migrate`, the latter using the **unpooled** URL — pgbouncer rejects some DDL).
- **Better Auth** (`lib/auth.ts`): passwordless **magic link**, **DB-backed sessions** (not JWT), Drizzle adapter.
- **Resend** (`lib/email.ts`) sends the magic-link email. `MAGIC_LINK_SINK` is a dev/test seam that writes the raw link to a file instead of emailing — hard-disabled in production.

### Verified contracts (bit us or would have)
| Contract | Finding |
|---|---|
| neon-http has **no interactive transactions** | `db.transaction()` isn't available. Better Auth's Drizzle pg adapter reports `transaction: false` and never calls it, so neon-http is safe. The one multi-statement op we own (consume invite) uses **`db.batch([...])`**, which neon-http runs atomically. |
| Better Auth Drizzle **CLI diff** | Schema is faithful to Better Auth's official pg snapshot (singular table names, exact columns); `@better-auth/cli generate` produces an empty diff. Don't rename/drop those columns. |
| Atomic per-user quota without a txn | A single `INSERT … ON CONFLICT (userId, day) DO UPDATE SET count = count + 1 RETURNING count` is atomic server-side — sufficient for the daily counters. Day boundary = UTC (deterministic on serverless). |
| Returning users skip the gate | `databaseHooks.user.create.before` runs only for brand-new emails (Better Auth finds returning users by email first), so a returning user logs in with the link alone. |

### The invite gate (the hard security crux)
Email = identity; a **redeemed invite code = access**. Flow: `POST /api/invite/verify {code, email}` validates the code and upserts a short-lived `pending_signups` row (a reservation, 15-min TTL, 30s per-email reissue cooldown). Account creation is then blocked in `user.create.before` unless an unexpired `pending_signups` row exists for that email — and re-checked still-redeemable to close the ≤15-min window where a code could be exhausted/deactivated. `user.create.after` consumes the reservation (delete + bump `usedCount`) in one `db.batch`, fail-safe (a failure just leaves the row to expire; the invited user keeps access). `maxUses` counts committed redemptions **plus** outstanding reservations to prevent last-slot overshoot.

**Rate-limiting the guessing** (`/api/invite/verify`): a cheap **per-isolate in-memory** burst limiter in front, plus a **durable per-IP** limiter (`invite_verify_attempts` table) — only failed (invalid/exhausted-code) attempts are recorded; >10 per IP per hour → 429, bounding guessing across isolates. Valid codes write nothing; old rows pruned on write.

### Search proxy + Worker lockdown
Browser → same-origin **`/api/search`** (`lib/search-client.ts`, still zero ML) → session check + atomic daily quota → forward to the Worker with **`X-Proxy-Secret: SEARCH_PROXY_SECRET`**. The Worker's first statement is a fail-closed secret check, so the billable Workers-AI pipeline can't be hit directly. The Worker URL + secret are server-only (never `NEXT_PUBLIC_*`). Ranking is byte-identical to the pre-proxy path. The proxy's Worker fetch has a 12s `AbortSignal.timeout` so a hung Worker fails fast with a 502 instead of holding the function to `maxDuration`. **These two must deploy together** (see SYNC-AND-DEPLOY's atomic rollout).

### Per-user quotas + shared guard
`lib/api-guard.ts` single-sources the session gate + quota for search/digest/chat: `requireUser()` → session or 401; `enforceQuota(userId, kind, limit)` → `null` (proceed), a localized-by-client **429** (`search_quota`/`digest_quota`/`chat_quota`), or a clean JSON **500** if the quota upsert itself fails (guarded — never leaks a stack). Limits: **search 300 / digest 10 / chat 40** per UTC day; the increment happens **before** the work so an over-limit request never reaches the Worker/OpenRouter. The UI keys off the `code` to show a localized "daily limit reached" message (search degrades to substring with a distinct notice; digest/chat show it in-panel via a `fetch` interceptor on useObject/useChat).

### Digest + chat persistence (cross-device)
Digests persist server-side in `/api/digest`'s `streamObject` **`onFinish`** — the response **tees** the stream and drains one branch via `after()`, so persistence completes even if the client disconnects mid-stream (disconnect-safe). One row per `(userId, query)` (`onConflictDoUpdate`) so a regen replaces rather than appends. Chats persist via explicit Save (`/api/chats` upsert, stable id per open conversation). Both are user-scoped (IDOR-safe per-route `WHERE userId`) and read back on load, replacing the old per-device localStorage; a one-shot idempotent localStorage→DB migration seeds pre-existing local history.

### Tables (app-owned, beyond Better Auth's core four)
`invite_codes`, `pending_signups`, `invite_verify_attempts`, `saved_digests`, `chat_sessions` + `chat_messages`, `ai_usage_daily` (PK `(userId, day)`; `searchCount`/`digestCount`/`chatCount`).

## 9. Data lockdown — private R2, no public CDN (T8)

**The problem.** Before T8 all bookmark data was static JSON under `public/data/*`, served by Vercel's
CDN. Even though the UI is invite-gated, the files themselves were publicly fetchable by URL — including
`all-bookmarks.json`, the user's **entire raw archive** (the actual private content), plus the vector /
lunr / rerank index (the paid-Workers-AI-embedding output). The login wall protected the *UI*, not the
*data*.

**The fix.** One **private R2 bucket** (`bookmark-search-data`) holds everything; nothing is served from
the CDN. Two consumer paths:
- **Search index** (`search-index-bge.bin` + `.meta.json`, `lunr-index.json`, `rerank-docs.json`) — read
  **server-side** by the Worker via its `SEARCH_DATA` R2 binding (`fetchAsset`/`loadData`), cached per
  isolate. Never touches the browser.
- **Raw archive** (`all-bookmarks.json`) — the browser's data Web Worker (`lib/data-worker.ts`) needs it
  to render cards, so it can't be Worker-server-only. It's served through **`/api/archive`** (Vercel,
  `requireUser` → JSON 401 if anon, allow-listed in `proxy.ts`) → secret-gated Worker **`GET /archive`**
  (`X-Proxy-Secret`, same gate as `/search`) → `SEARCH_DATA.get('all-bookmarks.json')`, **streamed**
  through both hops (no buffering the ~9 MB payload) with `Cache-Control: private, max-age=300`. No
  per-user quota (it's a once-per-load render fetch, not a billable model call — the session gate is the
  control). Reuses the existing `SEARCH_ENDPOINT` + `SEARCH_PROXY_SECRET`; **no new env vars.**

**`fetchAsset` dev fallback.** `fetchAsset` prefers R2, but on an R2 **miss** falls back to
`DATA_BASE_URL` *only if it's set*. Prod has no `DATA_BASE_URL` (removed from `wrangler.jsonc` vars) → a
miss is a hard, visible error. Local `wrangler dev` binds an **empty** local R2 simulation → every get()
misses → it falls back to the `worker/.dev.vars` `DATA_BASE_URL` (`localhost:8080/data`), so offline
dev/eval keep working against the files still on disk. (`wrangler dev --remote` uses the real R2 bucket —
used to validate the prod path before deploy.)

**Files leave git + CDN, stay on disk.** `.gitignore` ignores all of `public/data/`; `git rm --cached`
untracked it. The files remain in the working tree for dev/eval (`cd public && python3 -m http.server
8080`), but are gone from git history-going-forward and from the Vercel build (untracked ⇒ not deployed
⇒ 404 on the CDN). The private repo + private R2 are the only copies of the archive that ship anywhere.

**Refresh path.** `npm run upload:r2` (`scripts/upload-r2.mjs`, `wrangler r2 object put … --remote`) pushes
the 4 search assets + the archive to R2; it's the last step of `npm run sync`. Data no longer rides a
`git push` — see the updated SYNC-AND-DEPLOY runbook. **Requires R2 enabled on the account** (dashboard),
which was the one manual prerequisite.

**Verified (pre-deploy, against real R2 via `--remote`):** `/search "nextjs app router"` → 37 reranked
results (full R2→embed→lunr→rerank pipeline intact); `/archive` → byte-identical 9,173,483-byte stream;
Worker `GET /archive` gate returns 401 (no/wrong secret) / 405 (non-GET) / 200 (authed). Ranking code +
data are unchanged, so search results are identical to the CDN path — only the *source* moved.
