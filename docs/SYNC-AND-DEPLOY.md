# Sync & deploy runbook

The operational flow for pulling fresh bookmarks and getting them live. This is the single source of
truth; the README's "Syncing Fresh Bookmarks" section links here.

## Mental model — three moving parts, and data no longer rides the `git push`

- **Vercel** hosts the app + `/api` routes. Updated by a normal `git push` to `main`. **It no longer serves any data** — T8 removed `public/data/*` from git + the CDN (the files stay on disk locally, untracked, for dev/eval only).
- **Private R2 bucket** (`bookmark-search-data`) holds ALL runtime data — the search index **and** the raw archive (`all-bookmarks.json`). Updated by **`npm run upload:r2`** (folded into `npm run sync`), NOT by a `git push`.
- **The Cloudflare Worker** (`bookmark-search.*.workers.dev`) runs search and reads the data from **R2** via its `SEARCH_DATA` binding (cached per isolate). It also serves the archive to the logged-in browser at `GET /archive` (secret-gated, fronted by the session-gated `/api/archive`). It does **NOT** update on a `git push` — **redeploy it** (`npm run deploy:worker`) after any Worker/ranking change.

> After a data sync you must **`npm run upload:r2`** (push the new corpus to R2) — a `git push` does
> nothing for data anymore. If the Worker's *code* changed too, also `npm run deploy:worker`. This is
> the #1 thing to remember. (A stale R2 = the app + search both serve the old corpus.)

## Environment (auth / DB / search-proxy) — set in Vercel BEFORE the build

The app is invite-gated and account-based; search proxies through Vercel to a secret-locked Worker.
All of these are **server-only** (no `NEXT_PUBLIC_*`) and must exist in the Vercel project **before a
build** (they're read at build/runtime; `SEARCH_ENDPOINT`/`SEARCH_PROXY_SECRET` gate every search):

| Var | Purpose |
|---|---|
| `DATABASE_URL` / `DATABASE_URL_UNPOOLED` | Neon Postgres — pooled (runtime) / direct (migrations) |
| `BETTER_AUTH_SECRET` | session-signing secret |
| `BETTER_AUTH_URL` | the app's own origin (prod URL in prod) |
| `RESEND_API_KEY` | sends magic-link emails |
| `SEARCH_ENDPOINT` | the deployed Worker URL the proxy forwards to |
| `SEARCH_PROXY_SECRET` | shared secret the proxy sends; the Worker is fail-closed on it (`wrangler secret put SEARCH_PROXY_SECRET` on the Worker side) |
| `OPENROUTER_API_KEY` | digest / chat / expand |
| `DIGEST_UNLOCK_SECRET` | now ONLY the seed invite code (the passkey gate is retired) |

Apply DB migrations with `npm run db:migrate` (uses `DATABASE_URL_UNPOOLED`) when the schema changes.
Issue invite codes with `node scripts/add-invite.mjs <CODE> [label] [maxUses]`.

No new env vars are needed for the R2 data lockdown (T8): the Worker reaches R2 through its
`SEARCH_DATA` binding in `worker/wrangler.jsonc` (Cloudflare-side, not a Vercel var), and `/api/archive`
reuses the existing `SEARCH_ENDPOINT` + `SEARCH_PROXY_SECRET`.

## Atomic rollout — R2 + the Worker + the Vercel app go live TOGETHER

Search flows browser → `/api/search` (session + quota) → Worker (with `SEARCH_PROXY_SECRET`); the archive
flows browser → `/api/archive` (session) → Worker `GET /archive` → R2. The Worker **rejects any request
without the secret** and reads all data from **R2**, and after the merge the app **no longer serves
`/data/*`**. So R2 must be populated first, and the Worker + app must land in the **same window** — in
this order, without a gap:

1. **Populate R2:** `npm run upload:r2` (uploads the 4 search assets + `all-bookmarks.json` to
   `bookmark-search-data`). The Worker has no data until this runs.
2. **Confirm Vercel env** (from the table above) — especially `SEARCH_ENDPOINT` + `SEARCH_PROXY_SECRET`.
   The R2 lockdown adds **no** new Vercel vars.
3. **`npm run deploy:worker` FIRST** → deploys the R2-bound Worker (reads R2, adds `GET /archive`). This
   is **backward-compatible**: prod `/search` now serves from R2 (identical data), and the still-live old
   app keeps working (it fetches the public `/data/*`, which the old Vercel deployment still serves). No
   break.
4. **Push to `main`** → Vercel builds + atomically swaps to the new app. Only now does `/data/*` 404 —
   and by then the Worker's `/archive` + R2 are already live, so the browser's `/api/archive` fetch
   works from the first request.

Why worker-first: with the Worker already serving `/archive`, the Vercel swap is gap-free. The reverse
order (push first) would 404 `/data/*` while the old Worker still lacks `/archive` — a broken-archive
window until the deploy. Populate R2 **before** either step.

## MCP server rollout (docs/MCP-PLAN.md)

The MCP server (`/api/mcp`) is **Vercel-only**: no Worker deploy, no R2 upload. Its OAuth tables ship as an
additive migration, so the order is:

1. `npm run db:migrate` (creates `jwks` + `oauth*` tables; the live app ignores them).
2. Merge/push → Vercel. `BETTER_AUTH_URL` must be the canonical prod origin: it defines the token issuer and
   the MCP resource `${BETTER_AUTH_URL}/api/mcp`.
3. Smoke: `curl -i -X POST https://xbookmarks.tamasgabor.com/api/mcp` → `401` + `WWW-Authenticate: Bearer resource_metadata=…`.

A data sync needs nothing extra for MCP: the server-side archive cache refreshes from R2 (via the Worker) within 5 minutes.

## Cloudflare auth — per session, no token on disk (by design)

We deliberately do **not** keep a Cloudflare API token in the repo/working tree (no `worker/.env`).
Provide auth once per terminal session, using **either**:

```bash
cd worker && npx wrangler login && cd ..     # browser OAuth — lasts until it expires
# — or —
export CLOUDFLARE_API_TOKEN=<your-token>       # this shell only; create at
                                               # dashboard → API Tokens → "Edit Cloudflare Workers" (+ Workers AI)
```

Auth is needed only for:
- the **embed step of a sync** — and only when there are new/changed posts to embed (a no-op sync needs nothing),
- the **sync preflight** — only if an input file is missing and must be restored from R2 (normally a no-op),
- **`npm run upload:r2`** (pushes the corpus to R2), and
- **`npm run deploy:worker`**.

If auth is missing when the sync needs it, `scripts/sync-bge.mjs` fails fast with these exact instructions
(it won't hang). Your X/Twitter auth for `xrelay` is separate (browser cookies) and already configured.

## The full loop

```bash
# 0. (once per session, only if this sync will embed new posts or you'll deploy)
cd worker && npx wrangler login && cd ..        # or: export CLOUDFLARE_API_TOKEN=...

# 1. keep the bookmark CLI current, then pull + rebuild + push to R2
npm i -g x-relay-mcp@latest
npm run sync          # ends with `upload:r2` — the fresh corpus is now live in R2

# 2. (only if you changed the app / API / Worker code) ship code to Vercel
git commit -am "…" && git push        # NOTE: public/data is untracked — data does NOT ride this push

# 3. (only if the Worker's CODE changed) redeploy it — a data-only sync does NOT need this,
#    because upload:r2 already refreshed what the Worker reads from R2
npm run deploy:worker
```

> Data-only sync? Just `npm run sync` (which runs `upload:r2`) — you're done. `git push` /
> `deploy:worker` are only for **code** changes now.

### What `npm run sync` does
`prepare-sync.mjs` → `xrelay archive bookmarks` (incremental pull, `--limit 10000`) →
`backfill-articles.mjs` (fill X Article bodies) → `sync-bge.mjs` → `upload-r2.mjs`.

**`prepare-sync.mjs` (preflight — the safety net).** Since the T8 lockdown, `public/data/*` is
gitignored, so the two INCREMENTAL-INPUT files live only on local disk: `all-bookmarks.json` (xrelay's
append base) and `search-index-bge.json` (the embed reuse base). If either is **missing**, the preflight
restores it from R2 **before** xrelay runs. This is load-bearing: with `all-bookmarks.json` missing,
xrelay would do a capped fresh pull and silently **drop every bookmark beyond `--limit`** (the corpus is
already > 5000); with the embed base missing, `sync-bge` would do a full, costly re-embed. If a file is
missing and R2's state can't be confirmed (auth/network error) the preflight **STOPS the whole sync**
(exit 1) rather than risk truncation — only a confirmed "not in R2" is treated as a genuine first run.
When both files are present (the common case) it's a pure no-op needing no auth.

**`sync-bge.mjs`:**
1. runs an incremental **dry-run** to see what's pending (content-fingerprinted, so a backfilled article's
   stale main vector is re-embedded, not skipped-by-id);
2. **if nothing is pending → stops** (no `wrangler dev`, no auth needed) — the common case;
3. if pending → starts a throwaway `wrangler dev` (port **8799**, override `SYNC_BGE_WRANGLER_PORT`),
   embeds the new posts with bge-m3 via its gated `/embed` route, tears it down (even on error/Ctrl-C);
4. rebuilds `lunr-index.json`, `rerank-docs.json`, and repacks `search-index-bge.bin`/`.meta.json` so the
   Worker-served artifacts stay aligned with the corpus.

Then **`upload-r2.mjs`** pushes to the `bookmark-search-data` R2 bucket (needs Cloudflare auth): the 4
Worker-served search assets + `all-bookmarks.json`, **plus `search-index-bge.json` as a BACKUP-only
object** (the Worker never fetches it — it exists so the preflight above can restore the embed base after
a lost/fresh disk). Six objects total; prod picks up the new corpus immediately.

## Troubleshooting

- **"Cloudflare auth is required … not authenticated"** during sync → you skipped auth step 0. Run
  `wrangler login` or `export CLOUDFLARE_API_TOKEN=...` and re-run `npm run sync`.
- **Search / archive on prod still shows old results after a sync** → the corpus lives in R2 now, not on the CDN. `npm run sync` ends with `upload:r2`; if you ran the steps by hand, run **`npm run upload:r2`**. (`deploy:worker` is only needed for Worker *code* changes.)
- **Prod archive/cards fail to load; `/api/archive` 502s** → R2 is empty or missing `all-bookmarks.json`. Run `npm run upload:r2`. Verify with `cd worker && npx wrangler r2 object get bookmark-search-data/all-bookmarks.json --remote --pipe | wc -c`.
- **`Please enable R2 … [code: 10042]`** → R2 isn't enabled on the Cloudflare account. Enable it in the dashboard (R2 Object Storage → enable), then `npm run upload:r2`.
- **`[prepare-sync] REFUSING to continue`** → the sync preflight found a missing input file and couldn't reach R2 to restore it (usually Cloudflare auth). This is the safety net doing its job — it stopped rather than let xrelay truncate your archive. Fix auth (`wrangler login` / `CLOUDFLARE_API_TOKEN`) and re-run `npm run sync`.
- **Port 8799 in use** → `SYNC_BGE_WRANGLER_PORT=<free port> npm run sync`.
- **wrangler dev automation misbehaves** → the manual two-terminal fallback is documented in the README's Syncing section.
- **`rm` deletes to Trash** on this machine (`rm` aliased to `trash`) → use `/bin/rm` in scripts.

## Related
- Architecture, API contracts, and the debug history: `docs/ENGINEERING-NOTES.md`.
- Effort plan docs: `docs/{CLOUDFLARE-SEARCH,FOLLOWUPS,DIGEST-UPGRADE}-PLAN.md`.
