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

(Needed to embed new posts — over the Workers AI REST API — and to publish to R2. The token needs
*Workers R2 Storage: Edit*, *Workers AI: Read* and *Account Settings: Read*. For hands-off syncing use
the autopilot below, which keeps the token outside the repo.) See
**[docs/SYNC-AND-DEPLOY.md](docs/SYNC-AND-DEPLOY.md)** for the complete runbook.

Then, from the project root:

```bash
npm run sync
```

`sync` runs:

```bash
node scripts/prepare-sync.mjs        # restore the incremental inputs from R2 if they're missing locally
xrelay archive bookmarks --out public/data/all-bookmarks.json --limit 10000
node scripts/backfill-articles.mjs
node scripts/sync-bge.mjs            # embed new posts + rebuild the search artifacts
node scripts/upload-r2.mjs           # versioned publish to R2 (the live site picks it up within a minute)
```

- `xrelay archive bookmarks` fetches your bookmarks newest-first and stops once it hits already-archived IDs, prepending only the new ones. `--limit 5000` ensures the stop condition (not the default `40` cap) is what halts the pull.
- `scripts/backfill-articles.mjs` fetches the full article body (title + markdown) for any X Article bookmark that doesn't have one yet, via `xrelay`, and writes it into the archive in place. Idempotent — re-running only touches bookmarks with a still-empty article body — and exits `0` on ordinary single-item flakiness so it never fails a routine sync. This runs **before** embedding: a freshly-synced X Article has no body yet.
- `scripts/sync-bge.mjs` brings the Worker's server-side search artifacts up to date with the (possibly just-changed) archive, end to end, as a single command:
  1. Runs `embed-bge.mjs --dry-run` (local only, no network) to see what's actually pending. `embed-bge.mjs` is **incremental**: it embeds a post's main vector / article-chunk vectors only when they're new, or when a content fingerprint (a hash of the exact text last embedded) no longer matches the current text — which is what catches an X Article backfilled with its body *after* its main vector was first embedded (the classic stale-vector trap: skip-by-id alone would miss that the text changed). Unchanged (id, part) pairs are always skipped.
  2. If nothing is pending (the common case for a routine sync with no new articles), it stops here — no embedding, no network calls.
  3. If something is pending, it embeds over the **Workers AI REST API** with your `CLOUDFLARE_API_TOKEN` (same bge-m3 model and billing as the Worker's AI binding; no local server, so no port can collide). Only when the token lacks the *Workers AI* permission does it fall back to a throwaway `wrangler dev` on an OS-assigned free port, probed before use and torn down even on error or Ctrl-C. Force either with `EMBED_TRANSPORT=rest|local`.
  4. Either way, it rebuilds `lunr-index.json` (`build-lunr-index.mjs`) and `rerank-docs.json` (`build-rerank-docs.mjs`) from the current archive, and repacks `search-index-bge.bin`/`.meta.json` (`pack-bge-index.mjs`) from `search-index-bge.json` — keeping the three Worker-served artifacts aligned with the corpus.

  Manual fallback, if you ever need it: in one terminal `cd worker && npx wrangler dev --port 8787`; in another, `export EMBED_SECRET="$(grep -E '^EMBED_SECRET' worker/.dev.vars | cut -d= -f2- | tr -d '\"')"` (the `/embed` route is gated on it — skip this and you'll get confusing 403 retry-storms, not a clear error), then `EMBED_URL=http://localhost:8787/embed node scripts/embed-bge.mjs` followed by `node scripts/build-lunr-index.mjs` / `build-rerank-docs.mjs` / `pack-bge-index.mjs`.

That's it — nothing to commit and nothing to redeploy. `public/data/*` is gitignored (the data lives in
the private R2 bucket), and `upload-r2.mjs` publishes **versioned**: the four search files go to
`v/<hash>/…` and `manifest.json` is switched last, so the site never serves a half-uploaded mix. The
deployed Worker re-checks the manifest once a minute and serves the new version (its `/search`
responses carry an `x-data-version` header). `npm run deploy:worker` is only for Worker **code** changes.

### Autopilot: unattended sync with launchd

Syncing runs on its own on macOS. A launchd agent ticks `scripts/auto-sync.mjs` every hour and at login; a tick only syncs when one is due — once a day from 14:00, retried every 2 h after a failure (up to 4 times), a missed day caught up as soon as the Mac is awake. It does the same steps as `npm run sync` with extra safety, because nobody is watching.

```bash
npm run autosync -- setup            # one-time (and to repair): xrelay, X auth, Cloudflare token, schedule,
                                     #   branded notifications, health check — safe to re-run
npm run autosync -- run              # sync NOW (the first time, allow macOS's "node wants to access Documents")
npm run autosync -- status           # last success, next attempt, auth, last run
npm run autosync -- doctor           # ✓/⚠/✖ for every dependency, with the fix
npm run autosync -- open             # status page (what clicking a notification opens)
npm run autosync -- logs             # latest run log
npm run autosync -- notify-test      # test notification (and the one-time macOS permission prompt)
npm run autosync -- set-token        # Cloudflare API token → login Keychain (or --env-file / --1password op://… / --op-service-account)
npm run autosync -- set-cookies      # X cookies (auth_token + ct0) → env file, for a box without a logged-in browser
npm run autosync -- install          # options: --hour 9 --minute 30 --notify changes|always|failure|never
                                     #   --browser chrome --account-id <cf-id> --worker-url <url> --site-url <url>
npm run autosync -- uninstall
npm run autosync:run -- --dry-run    # preflight only, in your terminal (also: --force-upload, --no-notify, --embed=local)
```

What the autopilot adds on top of `npm run sync`:

- **Fixes itself.** Hourly ticks with same-day retries, catch-up after sleep/shutdown, offline ticks that don't use up attempts, `caffeinate` during a run, an atomic lock against overlapping runs, per-step timeouts and retries, and a weekly xrelay update (only when newer; rolled back if X auth breaks).
- **Clear notifications.** They come from *X Bookmarks Sync* (its own icon, `~/Applications/X Bookmarks Sync.app`); clicking one opens the status page. Success says "+N new bookmarks"; a failure names the cause and the fix ("X login expired — log into x.com…"), once per cause per day and only when retrying won't help or it was the day's last attempt; "No bookmark sync for 3 days" if it keeps failing.
- **Checks before touching data.** Disk space, network, X auth (`xrelay whoami`) and the Cloudflare token (verified via the API, ~1 s).
- **Cloudflare auth from an env file, 1Password or the Keychain.** An API token that is never stored in the repo, from the first source that works: `CLOUDFLARE_API_TOKEN` in the environment or in `~/.config/xbookmarks-sync/env` (mode 600; it can also hold `XRELAY_COOKIES`), then `op read <op:// reference>` (1Password — via the app with Touch ID, or unattended through a service account whose token is kept in the Keychain), then the macOS Keychain (service `xbookmarks-sync`). The token needs *Workers R2 Storage: Edit*, *Workers AI: Read* and *Account Settings: Read*.
- **Safe publishing.** The archive is backed up before the pull and restored if it would shrink (nothing is published). Data is published whenever it differs from what was **last published**, so a failed upload is retried. The publish is versioned: files go to `v/<hash>/…` and `manifest.json` is switched last, so the site never serves a half-uploaded mix; the run then confirms the live Worker serves the new version.
- **History.** `~/Library/Logs/xbookmarks-sync/`: one log per run (last 30), `runs.jsonl`, `last-run.json`, `status.html`. Config and state live in `~/.config/xbookmarks-sync/`.

#### Running it on a headless Mac mini

The env file is designed for this case: no Keychain to unlock, no 1Password password, and no browser needed.

```bash
git clone <repo> && cd agentic-engineer-bookmarks && npm install
npm run autosync -- set-token --env-file     # Cloudflare API token → ~/.config/xbookmarks-sync/env (chmod 600)
npm run autosync -- set-cookies              # X auth_token + ct0, from a browser that's logged into x.com
npm run autosync -- setup                    # installs xrelay, schedule, notifier; runs the health check
npm run autosync -- run && npm run autosync -- status
```

- **No local data needed.** On the first run, `prepare-sync` restores `all-bookmarks.json` and the embedding base from R2. Embedding runs over the Workers AI REST API, so no local server or port is involved.
- **Check it remotely.** `npm run autosync -- doctor` over SSH shows ✓/✖ for every dependency with the fix; `status` shows the last success and the next attempt.
- **The agent needs a logged-in user.** A LaunchAgent only runs while that user is logged in, so turn on **automatic login** for it (System Settings → Users & Groups) so that runs resume after a reboot or power cut.
- **Don't run it on both machines.** Two Macs pulling into two separate local archives is harmless, because each run is incremental and R2 just gets the latest upload. But it's pointless: uninstall the agent on the laptop (`npm run autosync -- uninstall`) once the mini is running it.
- **Expired X cookies.** The cookies last until that X session is logged out. When they expire, the run stops at preflight and notifies you ("X login expired"); run `set-cookies` again and it retries on its own.

After a Node upgrade (fnm/nvm), run `install` again: the agent pins the real path of the Node binary it was installed with. macOS may ask once more for Documents access.

### Related scripts

```bash
npm run autosync -- status   # the autopilot (see above); also: doctor · open · run
npm run test:autosync    # unit tests for the autopilot's scheduling / error classification / lock / publish decision
npm run sync:bge         # the bge chain alone (embed new posts + lunr/rerank/pack), no xrelay fetch; EMBED_TRANSPORT=rest|local
npm run embed:bge        # embed-bge.mjs directly — add --dry-run (report only) or --full (from-scratch rebuild)
npm run upload:r2        # versioned publish of the local data to R2 (add -- --force to re-upload an unchanged version)
npm run deploy:worker    # redeploy the Cloudflare Worker after Worker CODE changes (data reaches it via upload:r2)
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
