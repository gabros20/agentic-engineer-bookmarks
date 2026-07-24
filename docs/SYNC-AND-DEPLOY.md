# Sync & deploy runbook

The operational flow for pulling fresh bookmarks and getting them live. This is the single source of
truth; the README's "Syncing Fresh Bookmarks" section links here.

## Mental model — two deploy targets, one is easy to forget

- **Vercel** hosts the app + serves the search data files (`public/data/*`). Updated by a normal `git push` to `main`.
- **The Cloudflare Worker** (`bookmark-search.*.workers.dev`) runs the actual search and **fetches the data from Vercel, caching it per isolate**. It does **NOT** update on a `git push` — you must **redeploy it** (`npm run deploy:worker`) whenever the data (or its ranking code) changes.

> If you only `git push` after a sync, the *app* shows new data but *search* keeps serving the old
> corpus until you `npm run deploy:worker`. This is the #1 thing to remember.

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

## Atomic rollout — the locked Worker and the Vercel app go live TOGETHER

Search now flows browser → `/api/search` (session + quota) → Worker (with `SEARCH_PROXY_SECRET`), and the
Worker **rejects any request without that secret**. So the locked Worker and the app that calls it with
the secret must land in the **same window** — do them in this order, without a gap:

1. **Set the Vercel env vars above** (all environments as appropriate) — especially `SEARCH_ENDPOINT`
   + `SEARCH_PROXY_SECRET` — **before** triggering the build.
2. **Merge to `main`** → Vercel builds + deploys the app + `/api` routes (now calling `/api/search`).
3. **`npm run deploy:worker`** immediately → deploys the secret-gated Worker.

Why together: deploying the locked Worker **before** the new app ships would 401 the currently-live public
search; merging the app **before** the Worker is locked leaves `/api/search` forwarding a secret the live
Worker doesn't yet require (harmless, but the lockdown isn't in effect). Keep the gap as small as possible.

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
- the **embed step of a sync** — and only when there are new/changed posts to embed (a no-op sync needs nothing), and
- **`npm run deploy:worker`**.

If auth is missing when the sync needs it, `scripts/sync-bge.mjs` fails fast with these exact instructions
(it won't hang). Your X/Twitter auth for `xrelay` is separate (browser cookies) and already configured.

## The full loop

```bash
# 0. (once per session, only if this sync will embed new posts or you'll deploy)
cd worker && npx wrangler login && cd ..        # or: export CLOUDFLARE_API_TOKEN=...

# 1. keep the bookmark CLI current, then pull + rebuild
npm i -g x-relay-mcp@latest
npm run sync

# 2. ship the data to Vercel
git add public/data && git commit -m "sync fresh bookmarks" && git push

# 3. refresh the Worker so search sees the new data (git push does NOT do this)
npm run deploy:worker
```

### What `npm run sync` does
`xrelay archive bookmarks` (incremental pull) → `backfill-articles.mjs` (fill X Article bodies) →
`sync-bge.mjs`, which:
1. runs an incremental **dry-run** to see what's pending (content-fingerprinted, so a backfilled article's
   stale main vector is re-embedded, not skipped-by-id);
2. **if nothing is pending → stops** (no `wrangler dev`, no auth needed) — the common case;
3. if pending → starts a throwaway `wrangler dev` (port **8799**, override `SYNC_BGE_WRANGLER_PORT`),
   embeds the new posts with bge-m3 via its gated `/embed` route, tears it down (even on error/Ctrl-C);
4. rebuilds `lunr-index.json`, `rerank-docs.json`, and repacks `search-index-bge.bin`/`.meta.json` so the
   three Worker-served artifacts stay aligned with the corpus.

## Troubleshooting

- **"Cloudflare auth is required … not authenticated"** during sync → you skipped auth step 0. Run
  `wrangler login` or `export CLOUDFLARE_API_TOKEN=...` and re-run `npm run sync`.
- **Search on prod still shows old results after a sync** → you forgot `npm run deploy:worker` (see the mental model).
- **Port 8799 in use** → `SYNC_BGE_WRANGLER_PORT=<free port> npm run sync`.
- **wrangler dev automation misbehaves** → the manual two-terminal fallback is documented in the README's Syncing section.
- **`rm` deletes to Trash** on this machine (`rm` aliased to `trash`) → use `/bin/rm` in scripts.

## Related
- Architecture, API contracts, and the debug history: `docs/ENGINEERING-NOTES.md`.
- Effort plan docs: `docs/{CLOUDFLARE-SEARCH,FOLLOWUPS,DIGEST-UPGRADE}-PLAN.md`.
