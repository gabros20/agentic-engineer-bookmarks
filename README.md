# X Bookmarks

A Next.js app for browsing a personal archive of saved X bookmarks. The app is **private and invite-only** — every page and API route is behind a passwordless magic-link login, and accounts can only be created by redeeming an invite code.

The app renders a static JSON export as searchable cards with hybrid (keyword + semantic) search served by a Cloudflare Worker (proxied through an authenticated Vercel route), sorting/filtering, starring, an AI Digest that summarizes search results, and a ⌘K AI chat that can search the archive — all bilingual (English / Magyar). Saved digests and chats persist to a Postgres database and sync across your devices. Fresh bookmarks are pulled and appended incrementally with the [`xrelay`](https://github.com/gabros20/x-relay) CLI.

## Live App

- Production: <https://xbookmarks.tamasgabor.com> (the old `agentic-engineer-bookmarks.vercel.app` 308-redirects here)
- MCP server: `https://xbookmarks.tamasgabor.com/api/mcp` — see [MCP server](#mcp-server)
- Repository: <https://github.com/gabros20/agentic-engineer-bookmarks>

## Data

Bookmark data and the search artifacts the Cloudflare Worker serves live as static JSON/binary under `public/data/`:

```text
public/data/all-bookmarks.json          # the bookmark archive (xrelay ArchiveFile shape)
public/data/search-index-bge.bin        # packed int8 bge-m3 embeddings, row-major [vector_count × 1024] — what the Worker actually fetches
public/data/search-index-bge.meta.json  # { model, dimensions, count, vector_count, items:[{id, part?}] }, same row order as the .bin
public/data/lunr-index.json             # serialized Lunr keyword index (`lunr.Index.load(...)`) — same field/boost config as lib/bookmark-search.ts
public/data/rerank-docs.json            # { [id]: rerankDocText } — per-post text the bge-reranker-base cross-encoder reranks against
public/data/search-index-bge.json       # source JSON search-index-bge.bin/.meta.json are packed FROM; also embed-bge.mjs's incremental resume state (per-item content fingerprint — see Syncing Fresh Bookmarks)
public/data/search-index.json           # LEGACY: int8 multilingual-e5-small embeddings (schema v2) — not read by the shipped search; kept for scripts/eval-search.mjs's e5 baseline and the offline scripts/bookmark-search.mjs CLI
```

Current export:

- `5,594` saved posts
- `204` X Article bookmarks, all `204` with full article text backfilled
- `4,702` posts with media
- `2,527` posts with video/GIF media
- Source: X bookmarks fetched through [`xrelay`](https://github.com/gabros20/x-relay) (`x-relay-mcp`)

The archive file is in xrelay's native `ArchiveFile` shape (`{ schema: "x-relay/archive@1", source, generatedAt, count, tweets: [...] }`). The app's data layer (`lib/xrelay-archive.ts`) maps each `ArchiveTweet` to its render shape on load and also accepts the legacy `{ data: [...] }` shape, so it keeps working across formats. X Article bookmarks carry their full body as `articleTitle`/`articleText` (markdown), backfilled via `xrelay` (see [Syncing Fresh Bookmarks](#syncing-fresh-bookmarks)) and searched/embedded alongside the post text.

The bge search index mirrors the old e5 index's schema v2 chunking: alongside each post's main embedding (raw text, `@cf/baai/bge-m3` — no e5-style prefix), long article bodies are split into ~280-word chunks (title-prefixed, on paragraph boundaries) and embedded separately, so a long article's semantic match isn't diluted into one averaged vector. `count` is the number of bookmarks (`5,594`); `vector_count` is the total number of embedded items including chunks (`6,840`). At query time (inside the Worker), per-bookmark scores are max-pooled across a bookmark's main vector and all of its chunks before ranking, so a multi-chunk article still contributes exactly one ranked result, never duplicates.

Saved digests and chats are now **DB-backed and user-scoped** (Neon Postgres) — they are the single source of truth and sync across every device you sign in on. Only favorites and language remain per-browser in `localStorage`:

```text
localStorage["agentic-engineer-bookmarks:favorites"]
localStorage["agentic-engineer-bookmarks:lang"]
```

(The legacy `…:digests` / `…:chats` localStorage keys are read once, on first load after signing in, to migrate any pre-existing local history into the DB — idempotent and non-destructive — then no longer used.)

## Features

- Hybrid search: a Cloudflare Worker (Workers AI, free tier) fuses `bge-m3` semantic embeddings with Lunr keyword matching, then reranks the top results with a `bge-reranker-base` cross-encoder pass — the client ships no ML and just renders the ranked results (see [Search architecture](#search-architecture))
- Exact / Broad precision toggle, with a **Relevance** sort option that reflects the live hybrid/rerank ranking (auto-selected when you start typing a search, restoring your previous sort when you clear it)
- Query operators typed straight into the search box: `from:handle`, `before:YYYY-MM[-DD]`, `after:YYYY-MM[-DD]` — parsed out as removable chips and applied as hard filters alongside the text search
- Relevance floors drop low-confidence broad-mode matches instead of padding results out to a fixed count, so a narrow query returns a short, high-precision list rather than a long tail of noise
- Search by post text, author, handle, URL, article title (with full article body for X Article bookmarks), and quoted-post text
- **LLM query expansion** (`/api/expand`, session-gated): broad-precision searches get up to 3 short LLM rewrites — an English translation for non-English queries, a synonym-rich rephrase, and a narrower variant — merged with the static synonym expansions before embedding, so Hungarian-language searches match English-language saved content
- Sort by relevance, newest, oldest, most bookmarked, or most liked; filter to starred / article / media / photo / video / text-only
- **AI Digest** — summarize the top search results into themes via OpenRouter (`google/gemini-3.6-flash`), persisted server-side to the database and reopenable from a saved list on any device
- **⌘K AI chat** — ask questions; the agent searches your archive with browser-side tools (AI SDK v6 + AI Elements); saved chats are DB-backed and sync cross-device
- **MCP server** (`/api/mcp`) — search your archive from Claude Code, claude.ai, Cursor or any MCP client, with the same ranking, operators and quota as the web app, behind the same invite-gated login (OAuth 2.1) — see [MCP server](#mcp-server)
- **Per-user daily quotas** on the cost-bearing endpoints (search 300 / digest 10 / chat 40 per day); hitting a cap shows a clear, localized "daily limit reached" message rather than failing silently
- Bilingual UI and AI output (English / Magyar) with flag switcher
- Star/unstar with local persistence; open the original post on `x.com`
- JSON parsed off the main thread in a Web Worker with skeleton loading
- Responsive, Anthropic-styled card layout

The whole app is behind login (Better Auth magic link + Neon Postgres sessions). All server routes — search, Digest, chat, query expansion — require a valid session (401 otherwise); the OpenRouter key (`OPENROUTER_API_KEY`) and the Worker's shared secret are server-side only. The Cloudflare Worker is no longer publicly reachable: browser search goes through the authenticated `/api/search` proxy, which forwards to the Worker with a server-only `SEARCH_PROXY_SECRET` (the Worker is fail-closed on it).

The client downloads no model and does no embedding or reranking — every keystroke sends the query to `/api/search` over the network, which returns ranked results. If the Worker (or the proxy) is unreachable, or the daily search quota is spent, search degrades gracefully to a plain client-side substring match over the already-loaded posts, with a status notice explaining why.

## Search architecture

Client → `/api/search` (Vercel proxy) → Cloudflare Worker → Vercel-hosted data: the browser sends each query same-origin to `/api/search`, which authenticates the session and checks the per-user daily search quota, then forwards to the Worker's `/search` endpoint with a server-only `SEARCH_PROXY_SECRET` (the Worker rejects any request without it). The Worker runs the hybrid pipeline (Lunr keyword ⊕ `bge-m3` semantic ⊕ `bge-reranker-base` rerank, via Workers AI) over index data it fetches from the static JSON in `public/data/` on Vercel and caches per isolate; it returns a ranked `{id, score}` list that the client renders — no ML, embeddings, index, Worker URL, or secret ever ship to the browser.

Because the Worker caches that data per isolate, a bookmark sync (`npm run sync`) only updates what's live once the Worker is redeployed with the refreshed data — see [Syncing Fresh Bookmarks](#syncing-fresh-bookmarks).

## MCP server

The app is also a remote **[Model Context Protocol](https://modelcontextprotocol.io) server**, so an AI client can search your bookmarks directly:

```text
https://xbookmarks.tamasgabor.com/api/mcp        (Streamable HTTP, OAuth 2.1)
```

### Connect a client

```bash
# Claude Code
claude mcp add --transport http x-bookmarks https://xbookmarks.tamasgabor.com/api/mcp
# then run /mcp in Claude Code → x-bookmarks → Authenticate (opens your browser)
```

- **claude.ai / Claude Desktop:** Settings → Connectors → *Add custom connector* → paste the URL.
- **Cursor / VS Code / others:** add it as a remote (HTTP) MCP server, e.g. `{"mcpServers": {"x-bookmarks": {"url": "https://xbookmarks.tamasgabor.com/api/mcp"}}}`.
- **Debugging:** `npx @modelcontextprotocol/inspector` → Transport *Streamable HTTP* → the URL above.

The first connection opens the normal login page (invite code + email → magic link). The magic link brings you straight back into the flow, then a **consent screen** asks you to allow the client read-only access. The client receives a 1-hour access token plus a refresh token, so it stays connected. Only invite-created accounts can finish this flow: the MCP server has no separate user list and adds no new way to create an account.

### Tools

| Tool | What it does | Quota |
|---|---|---|
| `search_bookmarks` | Hybrid keyword + semantic + reranked search, the same Worker pipeline as the web UI. Args: `query` (can include `from:`/`after:`/`before:` operators), `precision` (`exact`\|`broad`, default `broad`; broad also adds the LLM query rewrites, so Hungarian queries work), `limit` (1–60, default 20), `filter` (`all`\|`article`\|`media`\|`text`), and optional `from`/`after`/`before`. Returns ranked excerpts with `id`, `url`, author, date, likes/bookmarks and `score`. An operators-only query (e.g. `from:tom_doerr after:2026-08`) lists matches newest-first. | Counts against the **same 300/day search quota** as the web app. Operators-only listings are free. |
| `get_bookmark` | One bookmark in full by `id`: post text, X Article title + markdown body, metrics, url. | Free |

Both tools are read-only. `search_bookmarks` degrades to a plain substring match (and says so in `warnings`) if the search Worker is unreachable, like the web UI does.

### How it works

```text
MCP client ──Bearer JWT──▶ /api/mcp  (Vercel, Next.js route)
                             │ requireMcpAuth: verify JWT locally (JWKS) — issuer, audience=/api/mcp, expiry, scope bookmarks:read
                             │ token `sub` = Better Auth user id → per-user quota (ai_usage_daily, "search")
                             ▼
                   lib/server/bookmark-service.ts
                             │ operators + content filter + LLM rewrites (same helpers as the UI)
                             ├─▶ Worker POST /search  (X-Proxy-Secret) → ranked {id, score}
                             └─▶ Worker GET /archive  (X-Proxy-Secret) → archive, cached per instance for 5 min → hydrate ids into posts
```

- **Auth server = Better Auth.** `lib/auth.ts` adds `jwt()` (signs access tokens; keys in the `jwks` table), `mcp()` (the OAuth 2.1 provider, bound to the `/api/mcp` resource, with login at `/login` and consent at `/consent`) and `cimd()` (Client ID Metadata Documents, the MCP 2026-07-28 way for clients to identify themselves). Open Dynamic Client Registration is also on, for clients that don't support CIMD yet. Registering a client grants nothing: every token still needs an invite-gated login plus explicit consent.
- **Discovery:** `/.well-known/oauth-protected-resource/api/mcp` and `/.well-known/oauth-authorization-server/api/auth` are served by `app/.well-known/[...path]` (forwarded to Better Auth).
- **Transport:** `@modelcontextprotocol/server` v2 `createMcpHandler`. It serves the 2026-07-28 revision natively and falls back to per-request stateless serving for 2025-era clients. No session store is needed, which fits Vercel functions.
- **No Worker change.** Ranking is identical to the web app's: the MCP path calls the same `/search` and `/archive` endpoints with the same secret. The filters the UI used to apply only in the browser (operators, content type) now live in `lib/bookmark-filters.ts`, shared by the UI and the server.

Design notes, decisions and the validation log: **[docs/MCP-PLAN.md](docs/MCP-PLAN.md)**.

## Stack

- Next.js `16` (App Router) · React `19` · Tailwind CSS `4`
- Search: a Cloudflare Worker (Workers AI) running `bge-m3` semantic embeddings, `bge-reranker-base` cross-encoder rerank, and Lunr keyword search — no ML on the client
- AI SDK v6 + `@ai-sdk/react` + AI Elements · OpenRouter (`@openrouter/ai-sdk-provider`)
- Auth: Better Auth (magic link) + `@better-auth/mcp` / `@better-auth/cimd` (OAuth 2.1 for MCP clients) · MCP: `@modelcontextprotocol/server` v2
- `motion` animations · Lucide icons · Vercel hosting

## Local Development

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # production build
```

### Environment variables (`.env.local`)

All are **server-side only** — none are `NEXT_PUBLIC_*`, and no secret is ever exposed to the browser.

```text
# Database (Neon Postgres)
DATABASE_URL=postgres://...            # pooled — the app's runtime connection
DATABASE_URL_UNPOOLED=postgres://...   # direct/unpooled — migrations only (drizzle-kit)

# Auth (Better Auth, passwordless magic link)
BETTER_AUTH_SECRET=...                 # session-signing secret (generate a random 32+ byte value)
BETTER_AUTH_URL=http://localhost:3000  # the app's own origin (prod origin in production)
RESEND_API_KEY=...                     # sends magic-link emails via Resend

# Search proxy → Cloudflare Worker
SEARCH_ENDPOINT=https://bookmark-search.<you>.workers.dev   # the deployed Worker URL
SEARCH_PROXY_SECRET=...                # shared secret; also `wrangler secret put SEARCH_PROXY_SECRET` on the Worker

# AI (OpenRouter) + the seed invite code
OPENROUTER_API_KEY=...                 # digest / chat / expand, via OpenRouter
DIGEST_UNLOCK_SECRET=...               # historical name; now ONLY the seed invite code (the passkey is retired)
```

### Database setup

The schema lives in `lib/db/schema.ts` (Drizzle ORM). Apply migrations to your Neon database:

```bash
npm run db:migrate      # applies drizzle/*.sql   (needs DATABASE_URL_UNPOOLED)
# npm run db:generate   # regenerate a migration after editing the schema
```

### Signing in (and inviting people)

Login is invite-gated: an account can only be created by an email that has first redeemed a valid invite code. The login screen asks for **an invite code + your email**, then emails a magic link.

1. **Seed the owner's code** (idempotent — uses `DIGEST_UNLOCK_SECRET`): `npm run db:seed-invite`
2. **Issue more invites** for other people:

   ```bash
   node scripts/add-invite.mjs <CODE> [label] [maxUses]     # or: npm run add-invite -- <CODE> [label] [maxUses]
   # e.g.  node scripts/add-invite.mjs river-otter-42 "Sam" 1     # single-use code labelled "Sam"
   #       node scripts/add-invite.mjs team-2026                  # unlimited uses, no label
   ```

   Share `<CODE>` with the person; they enter it + their email on the login screen to create their account.

**Local magic links without email:** set `MAGIC_LINK_SINK=/tmp/magic.jsonl` when running `npm run dev` and the raw sign-in URL is appended to that file instead of being emailed (dev/test only — hard-disabled in production). Open the captured URL to complete login.

## Syncing Fresh Bookmarks

New bookmarks are pulled and **appended incrementally** (only what's new since the last sync) using the global `xrelay` CLI. Make sure it's up to date (needs `>= 1.4.0` for the `archive` command):

```bash
npm i -g x-relay-mcp@latest
```

**Cloudflare auth (per session — no token is stored on disk by design).** The sync's embed step and
`npm run deploy:worker` need Cloudflare auth; provide it once per terminal with **either**:

```bash
cd worker && npx wrangler login && cd ..     # browser OAuth
# — or —
export CLOUDFLARE_API_TOKEN=<your-token>       # this shell only
```

(Only needed when a sync actually embeds new posts, or when you deploy. A no-op sync needs nothing.
If it's missing when required, the sync fails fast with these exact instructions.) See
**[docs/SYNC-AND-DEPLOY.md](docs/SYNC-AND-DEPLOY.md)** for the complete runbook.

Then, from the project root:

```bash
npm run sync
```

`sync` runs:

```bash
xrelay archive bookmarks --out public/data/all-bookmarks.json --limit 5000
node scripts/backfill-articles.mjs
node scripts/sync-bge.mjs
```

- `xrelay archive bookmarks` fetches your bookmarks newest-first and stops once it hits already-archived IDs, prepending only the new ones. `--limit 5000` ensures the stop condition (not the default `40` cap) is what halts the pull.
- `scripts/backfill-articles.mjs` fetches the full article body (title + markdown) for any X Article bookmark that doesn't have one yet, via `xrelay`, and writes it into the archive in place. Idempotent — re-running only touches bookmarks with a still-empty article body — and exits `0` on ordinary single-item flakiness so it never fails a routine sync. This runs **before** embedding: a freshly-synced X Article has no body yet.
- `scripts/sync-bge.mjs` brings the Worker's server-side search artifacts up to date with the (possibly just-changed) archive, end to end, as a single command:
  1. Runs `embed-bge.mjs --dry-run` (local only, no network) to see what's actually pending. `embed-bge.mjs` is **incremental**: it embeds a post's main vector / article-chunk vectors only when they're new, or when a content fingerprint (a hash of the exact text last embedded) no longer matches the current text — which is what catches an X Article backfilled with its body *after* its main vector was first embedded (the classic stale-vector trap: skip-by-id alone would miss that the text changed). Unchanged (id, part) pairs are always skipped.
  2. If nothing is pending (the common case for a routine sync with no new articles), it stops here — **no `wrangler dev`, no network calls at all.**
  3. If something is pending, it starts a local `wrangler dev` in `worker/` (Workers AI runs remotely even under `wrangler dev`, so this is required for real inference), waits for it to report ready, runs the incremental embed against its gated `POST /embed` route (`EMBED_SECRET` from `worker/.dev.vars`), then tears `wrangler dev` back down — including on error or Ctrl-C, so a failed sync never leaves an orphaned process.
  4. Either way, it rebuilds `lunr-index.json` (`build-lunr-index.mjs`) and `rerank-docs.json` (`build-rerank-docs.mjs`) from the current archive, and repacks `search-index-bge.bin`/`.meta.json` (`pack-bge-index.mjs`) from `search-index-bge.json` — keeping the three Worker-served artifacts aligned with the corpus.

  The script runs its throwaway `wrangler dev` on port **8799** by default (override with `SYNC_BGE_WRANGLER_PORT`) so it won't collide with a worker you may already be running on the conventional 8787.

  If the `wrangler dev` automation ever proves too brittle in some environment, the manual two-step fallback still works: in one terminal `cd worker && npx wrangler dev --port 8787`; in another, `export EMBED_SECRET="$(grep -E '^EMBED_SECRET' worker/.dev.vars | cut -d= -f2- | tr -d '\"')"` (the `/embed` route is gated on it — skip this and you'll get confusing 403 retry-storms, not a clear error), then `EMBED_URL=http://localhost:8787/embed node scripts/embed-bge.mjs` followed by `node scripts/build-lunr-index.mjs` / `build-rerank-docs.mjs` / `pack-bge-index.mjs`.

Then commit and push (Vercel redeploys on push to `main`):

```bash
git add public/data/all-bookmarks.json public/data/search-index-bge.json \
        public/data/search-index-bge.bin public/data/search-index-bge.meta.json \
        public/data/lunr-index.json public/data/rerank-docs.json
git commit -m "Sync fresh bookmarks"
git push
```

**The deployed Worker caches its data per isolate, so it does NOT pick up a fresh sync automatically** — after committing/pushing, redeploy it:

```bash
npm run deploy:worker   # cd worker && wrangler deploy — needs Cloudflare auth (wrangler login or CLOUDFLARE_API_TOKEN; see above)
```

### Autopilot: daily sync with launchd

Syncing can run on its own every day on macOS. A launchd agent runs `scripts/auto-sync.mjs`, which does the same steps as `npm run sync` with extra safety because nobody is watching. It survives restarts: agents in `~/Library/LaunchAgents` load at login, and if the Mac is asleep at the scheduled time, launchd runs the job once on wake.

```bash
npm run autosync -- set-token --env-file   # one-time: Cloudflare API token → ~/.config/xbookmarks-sync/env (chmod 600) — best for servers
npm run autosync -- set-cookies      # optional: X cookies (auth_token + ct0) → env file, so no logged-in browser is needed
npm run autosync -- set-token        # …or keep the token in the login Keychain — OR in 1Password:
npm run autosync -- set-token --1password "op://Automation/Cloudflare xbookmarks/credential"
npm run autosync -- set-token --op-service-account   # 1Password service-account token → Keychain: op reads run unattended (no Touch ID)
npm run autosync -- install          # daily at 14:00; options: --hour 9 --minute 30 --notify changes|always|failure|never
                                     #   --browser chrome (xrelay cookie source) --account-id <cf-id> --update-xrelay
npm run autosync -- run              # run it NOW under launchd (the first time, allow macOS's "node wants to access Documents" prompt)
npm run autosync -- status           # schedule, agent state, auth, last run (+N bookmarks, published or not)
npm run autosync -- logs             # latest run log
npm run autosync -- uninstall
npm run autosync:run -- --dry-run    # preflight only, in your terminal (also: --force-upload, --no-notify)
```

What the autopilot adds on top of `npm run sync`:

- **Cloudflare auth from an env file, 1Password or the Keychain.** `wrangler login` expires and can't renew itself without you, so unattended runs use an API token that is never stored in the repo. It comes from the first source that works: `CLOUDFLARE_API_TOKEN` in the environment or in `~/.config/xbookmarks-sync/env` (a `KEY=VALUE` file, mode 600, loaded into every run; it can also hold `XRELAY_COOKIES`), then `op read <op:// reference>` (1Password), then the macOS Keychain (service `xbookmarks-sync`). With 1Password there are two modes: through the 1Password app, which asks for Touch ID each run and fails if the app is locked; or, fully unattended, through a **service account** with read access to one vault, whose token is kept in the Keychain. The token needs *Workers R2 Storage: Edit*, *Workers AI: Read*, *Workers Scripts: Edit* and *Account Settings: Read* on your account. `set-token` checks it with `wrangler whoami`.
- **Checks before touching data.** X auth (`xrelay whoami`) and Cloudflare auth (`wrangler whoami`) are verified first. A failure stops the run and sends a macOS notification.
- **Truncation guard.** `all-bookmarks.json` is backed up before the pull. If the archive would shrink, the backup is restored and nothing is uploaded.
- **Upload only when data changed.** Uploads are skipped when the six R2 objects are unchanged; xrelay's `generatedAt` timestamp is ignored, so a quiet day costs no upload.
- **No overlaps, timeouts, retries.** A lock prevents overlapping runs (with a manual sync too), every step has a timeout, the network steps retry (`upload-r2` retries transient Cloudflare 5xx errors), and a flaky article backfill is only a warning.
- **Run history.** `~/Library/Logs/xbookmarks-sync/`: one log per run (last 30 kept), plus `last-run.json` and launchd's stdout/stderr. Config lives in `~/.config/xbookmarks-sync/config.json`.

#### Running it on a headless Mac mini

The env file is designed for this case: no Keychain to unlock, no 1Password password, and no browser needed.

```bash
git clone <repo> && cd agentic-engineer-bookmarks && npm install
npm i -g x-relay-mcp@latest                  # the xrelay CLI
npm run autosync -- set-token --env-file     # Cloudflare API token
npm run autosync -- set-cookies              # X auth_token + ct0, from a browser that's logged into x.com
npm run autosync -- install --hour 14 --minute 0 --notify failure
npm run autosync -- run && npm run autosync -- status
```

- **No local data needed.** On the first run, `prepare-sync` restores `all-bookmarks.json` and the embedding base from R2, and the autopilot creates the local-only `EMBED_SECRET` in `worker/.dev.vars`.
- **The agent needs a logged-in user.** A LaunchAgent only runs while that user is logged in, so turn on **automatic login** for it (System Settings → Users & Groups) so that runs resume after a reboot or power cut.
- **Don't run it on both machines.** Two Macs pulling into two separate local archives is harmless, because each run is incremental and R2 just gets the latest upload. But it's pointless: uninstall the agent on the laptop (`npm run autosync -- uninstall`) once the mini is running it.
- **Expired X cookies.** The cookies last until that X session is logged out. When `xrelay whoami` starts failing, the run stops at preflight and notifies you; then run `set-cookies` again.

After a Node upgrade (fnm/nvm), run `install` again: the agent pins the real path of the Node binary it was installed with. macOS may ask once more for Documents access.

### Related scripts

```bash
npm run autosync -- status   # the daily autopilot (see above)
npm run sync:bge         # the bge chain alone (embed-bge + wrangler-dev automation + lunr/rerank/pack), no xrelay fetch
npm run embed:bge        # embed-bge.mjs directly — add --dry-run (report only) or --full (from-scratch rebuild)
npm run deploy:worker    # redeploy the Cloudflare Worker so it picks up freshly-synced data
npm run build:search     # LEGACY: full rebuild of the unused e5 search-index.json from all-bookmarks.json
npm run embed:new        # LEGACY: incremental e5 embeddings only (no fetch) — kept for scripts/eval-search.mjs's baseline
npm run migrate:archive  # one-time: convert a legacy {data:[...]} export to ArchiveFile shape
npm run eval:search      # golden-query relevance scorecard (recall/mrr/ndcg) vs. scripts/eval-baseline.json
npm run test:search      # unit tests for the search pipeline (chunking, grouping, floors, rerank, F2 lib/builder drift guard)
npm run test:operators   # unit tests for from:/before:/after: query-operator parsing
```

A global `bookmark-search` CLI (`scripts/bookmark-search.mjs`) also runs the same hybrid pipeline standalone over the committed archive/index — see that script's `--help` for usage; it's what backs the `bookmark-search` Claude Code skill outside this project.

## Deployment

The project is connected to Vercel and GitHub. Pushing to `main` updates production through Vercel's Git integration.

**Schema changes ship before the code that needs them:** run `npm run db:migrate` against the production database *before* pushing (the MCP feature added the OAuth tables in `drizzle/0005_*.sql`; the migration only adds tables, so it's safe to run while the old app is live).

```bash
vercel --prod   # manual production deploy
```

The Cloudflare Worker (search) is deployed separately — see `npm run deploy:worker` above; it needs redeploying any time the synced data changes, since Vercel pushes alone don't reach it.

Because the live app calls the Worker through `/api/search` with a shared secret and the Worker is fail-closed on that secret, the **app deploy and the Worker deploy must go live together** — set the Vercel env vars (`SEARCH_ENDPOINT`, `SEARCH_PROXY_SECRET`, `BETTER_AUTH_*`, `RESEND_API_KEY`, `DATABASE_URL`) **before** the build, then merge and `npm run deploy:worker` in the same window. The full atomic sequence is in **[docs/SYNC-AND-DEPLOY.md](docs/SYNC-AND-DEPLOY.md)**.

## Notes

- The bookmark JSON is committed into the private repository (the data files are several MB; a large push may need `git config http.postBuffer 524288000`).
- Search runs server-side on a Cloudflare Worker that embeds/reranks with Workers AI and fetches its index data from the static JSON hosted on Vercel; a Neon Postgres database backs auth, sessions, invites, quotas, and saved digests/chats.
- Favorites and language are per-browser; saved digests and chats are DB-backed and sync across every device you sign in on.
- Every Vercel server route (`/api/search`, `/api/digest`, `/api/chat`, `/api/expand`, the invite + auth routes) requires a session, and `/api/mcp` requires an OAuth bearer token issued to a logged-in user; the Cloudflare Worker's `/search` endpoint is reachable only through the authenticated `/api/search` proxy holding `SEARCH_PROXY_SECRET` — see [Search architecture](#search-architecture).
- The bookmark data is no longer publicly fetchable: it lives in a private R2 bucket, read only by the secret-gated Worker (see [docs/SYNC-AND-DEPLOY.md](docs/SYNC-AND-DEPLOY.md)).
