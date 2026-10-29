# Sync & deploy runbook

The operational flow for pulling fresh bookmarks and getting them live. This is the single source of
truth; the README's "Syncing Fresh Bookmarks" section links here.

## Mental model — three moving parts, and data no longer rides the `git push`

- **Vercel** hosts the app + `/api` routes. Updated by a normal `git push` to `main`. **It no longer serves any data** — T8 removed `public/data/*` from git + the CDN (the files stay on disk locally, untracked, for dev/eval only).
- **Private R2 bucket** (`bookmark-search-data`) holds ALL runtime data — the search index **and** the raw archive (`all-bookmarks.json`). Updated by **`npm run upload:r2`** (folded into `npm run sync`), NOT by a `git push`.
- **The Cloudflare Worker** (`bookmark-search.*.workers.dev`) runs search and reads the data from **R2** via its `SEARCH_DATA` binding — through `manifest.json`, which names the live data version (cached per isolate, re-checked once a minute, so a new publish goes live without a redeploy; `/search` answers carry `x-data-version`). It also serves the archive to the logged-in browser at `GET /archive` (secret-gated, fronted by the session-gated `/api/archive`). It does **NOT** update on a `git push` — **redeploy it** (`npm run deploy:worker`) after any Worker/ranking change.

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

## Autopilot (unattended sync)

`scripts/auto-sync.mjs` runs the same five steps as `npm run sync`, driven by a per-user launchd agent
(`scripts/autosync.mjs` installs and manages it).

**Setup (one command, safe to re-run to repair):** `npm run autosync -- setup` installs xrelay if missing,
checks X auth, stores/verifies the Cloudflare token (and caches the account id), infers the Worker/site
URLs, builds the branded notifier app, installs the launchd agent, sends a test notification (allow it
when macOS asks) and runs the health check. Then `npm run autosync -- run` for the first sync.

**Day to day:** `status` (last success, next attempt, auth, last run) · `doctor` (✓/⚠/✖ per dependency
with the fix) · `open` (status page — also what clicking any notification opens) · `run` (sync now,
ignoring the schedule once) · `logs` · `notify-test`.

- **Schedule:** launchd ticks every hour (at the configured minute) and at login; each tick is a no-op
  unless a sync is due (`scripts/lib/sync-state.mjs`): once a day from `hour:minute` (default 14:00), a
  failed run retried every `retryHours` (2) up to `maxAttemptsPerDay` (4), a missed day (Mac off/asleep)
  caught up at the next tick, offline ticks retried hourly without using attempts. `caffeinate` keeps the
  Mac awake during a run. State: `~/.config/xbookmarks-sync/state.json`; history: `runs.jsonl` in the logs dir.
- **Notifications** come from `~/Applications/X Bookmarks Sync.app` (own name + icon). Success: "+N new
  bookmarks". Failures are classified (`scripts/lib/sync-errors.mjs`) and name the fix; retryable ones stay
  quiet until the day's last attempt, auth problems notify at once, one per cause per day; "No bookmark sync
  for N days" after `staleDays` (3).
- **Auth:** a Cloudflare **API token** (Workers R2 Storage: Edit + Workers AI: Read + Account Settings:
  Read) from the env file `~/.config/xbookmarks-sync/env` (`set-token --env-file`; best for a headless Mac
  mini, together with `set-cookies` for `XRELAY_COOKIES`), 1Password (`set-token --1password op://…` +
  `--op-service-account` to avoid Touch ID) or the Keychain (`set-token`). It's verified via the API (~1 s).
  X auth is xrelay's browser cookies: log into x.com again if `X login expired` is reported.
- **xrelay updates:** at most weekly, only when npm has a newer version, rolled back if X auth breaks after.
- **macOS privacy (TCC):** the repo lives under `~/Documents`, so the first launchd run makes macOS ask whether
  `node` may access Documents. Allow it. The grant is tied to the node binary path, so after a Node upgrade
  run `install` again and allow once more.
- **Safety:** a pull that would shrink `all-bookmarks.json` is rolled back and nothing is published; data
  is published whenever it differs from what was **last published** (so a failed upload is retried); one
  run at a time (atomic lock in `~/.config/xbookmarks-sync/`).

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

Auth is needed for:
- the **embed step of a sync** — only when there are new/changed posts. With `CLOUDFLARE_API_TOKEN` it
  embeds over the Workers AI REST API (token needs *Workers AI: Read*); with only a `wrangler login`
  session it falls back to a throwaway local `wrangler dev` on a free port,
- the **sync preflight** — only if an input file is missing and must be restored from R2 (normally a no-op),
- **`npm run upload:r2`** (publishes the corpus to R2; token needs *Workers R2 Storage: Edit*), and
- **`npm run deploy:worker`**.

The unattended autopilot keeps its token outside the repo (env file / 1Password / Keychain — see above).
Your X/Twitter auth for `xrelay` is separate (browser cookies).

## The full loop

```bash
# 0. (once per session, only if this sync will embed new posts or you'll deploy)
cd worker && npx wrangler login && cd ..        # or: export CLOUDFLARE_API_TOKEN=...

# 1. keep the bookmark CLI current, then pull + rebuild + push to R2
npm i -g x-relay-mcp@latest
npm run sync          # ends with `upload:r2` — versioned publish; the Worker serves it within a minute

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
2. **if nothing is pending → no embedding at all** — the common case;
3. if pending → embeds the new posts with bge-m3 over the **Workers AI REST API** using
   `CLOUDFLARE_API_TOKEN` (no local server, no port; `scripts/lib/embed-transport.mjs`). Only if the token
   lacks Workers AI permission does it fall back to a throwaway `wrangler dev` on an OS-assigned free port
   (probed before use, torn down on success/error/Ctrl-C). Force either with `EMBED_TRANSPORT=rest|local`.
   Bad token / dead server fail fast; 429/5xx/transient Workers AI errors back off (honoring Retry-After);
   progress is flushed atomically, so any re-run resumes;
4. rebuilds `lunr-index.json`, `rerank-docs.json`, and repacks `search-index-bge.bin`/`.meta.json`
   (all written atomically) so the Worker-served artifacts stay aligned with the corpus.

Then **`upload-r2.mjs`** publishes to the `bookmark-search-data` R2 bucket, **versioned and atomic**: the
four files the Worker loads together go to `v/<version>/…` (version = their content hash), then
`manifest.json` is switched to the new version **last** — the Worker reads the manifest, so it never sees a
half-uploaded mix, and every isolate re-checks it each minute (`x-data-version` on `/search` responses shows
what it serves). The last 3 versions are kept (rollback = point the manifest back); older ones are pruned.
`all-bookmarks.json` (for `/archive`) and the backup-only `search-index-bge.json` keep fixed keys. The
autopilot then polls the live Worker until it serves the new version (needs `workerUrl` in the config).

## Troubleshooting

- **"Cloudflare auth is required … not authenticated"** during sync → you skipped auth step 0. Run
  `wrangler login` or `export CLOUDFLARE_API_TOKEN=...` and re-run `npm run sync`.
- **Search / archive on prod still shows old results after a sync** → the corpus lives in R2 now, not on the CDN. `npm run sync` ends with `upload:r2`; if you ran the steps by hand, run **`npm run upload:r2`**. (`deploy:worker` is only needed for Worker *code* changes.)
- **Prod archive/cards fail to load; `/api/archive` 502s** → R2 is empty or missing `all-bookmarks.json`. Run `npm run upload:r2`. Verify with `cd worker && npx wrangler r2 object get bookmark-search-data/all-bookmarks.json --remote --pipe | wc -c`.
- **`Please enable R2 … [code: 10042]`** → R2 isn't enabled on the Cloudflare account. Enable it in the dashboard (R2 Object Storage → enable), then `npm run upload:r2`.
- **`[prepare-sync] REFUSING to continue`** → the sync preflight found a missing input file and couldn't reach R2 to restore it (usually Cloudflare auth). This is the safety net doing its job — it stopped rather than let xrelay truncate your archive. Fix auth (`wrangler login` / `CLOUDFLARE_API_TOKEN`) and re-run `npm run sync`.
- **Autopilot failure codes** (shown in the notification, `status`, and the status page):
  `X_AUTH` → log into x.com in your browser (or `set-cookies`) · `CF_AUTH` → `npm run autosync -- set-token` ·
  `OFFLINE` → nothing to do, it retries hourly · `AI_RATE_LIMIT` / `EMBED` / `UPLOAD` → transient, it retries
  automatically · `TRUNCATED` → the pull looked wrong, nothing was published, check xrelay · `DISK` → free 1 GB.
  `npm run autosync -- doctor` pinpoints which dependency is broken.
- **"live Worker still answers … instead of v…"** warning → the deployed Worker predates versioned data;
  `npm run deploy:worker`.
- **Embedding falls back to `wrangler dev`** → the token lacks "Workers AI: Read"; add it (`doctor` says so).
- **`rm` deletes to Trash** on this machine (`rm` aliased to `trash`) → use `/bin/rm` in scripts.

## Related
- Architecture, API contracts, and the debug history: `docs/ENGINEERING-NOTES.md`.
- Effort plan docs: `docs/{CLOUDFLARE-SEARCH,FOLLOWUPS,DIGEST-UPGRADE}-PLAN.md`.
