# X Bookmarks

A Next.js app for browsing a personal archive of saved X bookmarks.

The app renders a static JSON export as searchable cards with hybrid (keyword + semantic) search served by a Cloudflare Worker, sorting/filtering, starring, an AI Digest that summarizes search results, and a ⌘K AI chat that can search the archive — all bilingual (English / Magyar). Fresh bookmarks are pulled and appended incrementally with the [`xrelay`](https://github.com/gabros20/x-relay) CLI.

## Live App

- Production: <https://agentic-engineer-bookmarks.vercel.app>
- Repository: <https://github.com/gabros20/agentic-engineer-bookmarks>

## Data

Bookmark data and the semantic index live as static JSON:

```text
public/data/all-bookmarks.json   # the bookmark archive (xrelay ArchiveFile shape)
public/data/search-index.json    # int8 multilingual-e5-small embeddings (index schema v2)
```

Current export:

- `5,594` saved posts
- `204` X Article bookmarks, all `204` with full article text backfilled
- `4,702` posts with media
- `2,527` posts with video/GIF media
- Source: X bookmarks fetched through [`xrelay`](https://github.com/gabros20/x-relay) (`x-relay-mcp`)

The archive file is in xrelay's native `ArchiveFile` shape (`{ schema: "x-relay/archive@1", source, generatedAt, count, tweets: [...] }`). The app's data layer (`lib/xrelay-archive.ts`) maps each `ArchiveTweet` to its render shape on load and also accepts the legacy `{ data: [...] }` shape, so it keeps working across formats. X Article bookmarks carry their full body as `articleTitle`/`articleText` (markdown), backfilled via `xrelay` (see [Syncing Fresh Bookmarks](#syncing-fresh-bookmarks)) and searched/embedded alongside the post text.

The search index is schema v2: alongside each post's main embedding, long article bodies are split into ~280-word chunks (title-prefixed, on paragraph boundaries) and embedded separately, so a long article's semantic match isn't diluted into one averaged vector. `count` is the number of bookmarks (`5,594`); `vector_count` is the total number of embedded items including chunks (`6,840`). At query time, per-bookmark scores are max-pooled across a bookmark's main vector and all of its chunks before ranking, so a multi-chunk article still contributes exactly one ranked result, never duplicates.

The deployed app is static. Favorites, saved digests, saved chats, and language are personal to each browser:

```text
localStorage["agentic-engineer-bookmarks:favorites"]
localStorage["agentic-engineer-bookmarks:digests"]
localStorage["agentic-engineer-bookmarks:chats"]
localStorage["agentic-engineer-bookmarks:lang"]
```

## Features

- Hybrid search: a Cloudflare Worker (Workers AI, free tier) fuses `bge-m3` semantic embeddings with Lunr keyword matching, then reranks the top results with a `bge-reranker-base` cross-encoder pass — the client ships no ML and just renders the ranked results (see [Search architecture](#search-architecture))
- Exact / Broad precision toggle, with a **Relevance** sort option that reflects the live hybrid/rerank ranking (auto-selected when you start typing a search, restoring your previous sort when you clear it)
- Query operators typed straight into the search box: `from:handle`, `before:YYYY-MM[-DD]`, `after:YYYY-MM[-DD]` — parsed out as removable chips and applied as hard filters alongside the text search
- Relevance floors drop low-confidence broad-mode matches instead of padding results out to a fixed count, so a narrow query returns a short, high-precision list rather than a long tail of noise
- Search by post text, author, handle, URL, article title (with full article body for X Article bookmarks), and quoted-post text
- **LLM query expansion** (`/api/expand`, passkey-gated): broad-precision searches get up to 3 short LLM rewrites — an English translation for non-English queries, a synonym-rich rephrase, and a narrower variant — merged with the static synonym expansions before embedding, so Hungarian-language searches match English-language saved content
- Sort by relevance, newest, oldest, most bookmarked, or most liked; filter to starred / article / media / photo / video / text-only
- **AI Digest** — summarize the top search results into themes via OpenRouter (`gpt-5.4-nano`), cached in `localStorage` and reopenable from a saved list
- **⌘K AI chat** — ask questions; the agent searches your archive with browser-side tools (AI SDK v6 + AI Elements)
- Bilingual UI and AI output (English / Magyar) with flag switcher
- Star/unstar with local persistence; open the original post on `x.com`
- JSON parsed off the main thread in a Web Worker with skeleton loading
- Responsive, Anthropic-styled card layout

AI features (Digest, chat, query expansion) are gated behind a passkey stored as a `DIGEST_UNLOCK_SECRET` cookie; the OpenRouter key (`OPENROUTER_API_KEY`) is server-side only. Search itself (hybrid, operators, rerank) needs no passkey — it runs server-side on a public Cloudflare Worker, not in the browser.

The client downloads no model and does no embedding or reranking — every keystroke sends the query to the Worker over the network, which returns ranked results. If the Worker is unreachable, search degrades gracefully to a plain client-side substring match over the already-loaded posts.

## Search architecture

Client → Cloudflare Worker → Vercel-hosted data: the browser sends each query to the Worker's `/search` endpoint; the Worker runs the hybrid pipeline (Lunr keyword ⊕ `bge-m3` semantic ⊕ `bge-reranker-base` rerank, via Workers AI) over index data it fetches from the static JSON in `public/data/` on Vercel and caches per isolate; it returns a ranked `{id, score}` list that the client renders — no ML, embeddings, or index ever ship to the browser.

Because the Worker caches that data per isolate, a bookmark sync (`npm run sync`) only updates what's live once the Worker is redeployed with the refreshed data — see [Syncing Fresh Bookmarks](#syncing-fresh-bookmarks).

## Stack

- Next.js `16` (App Router) · React `19` · Tailwind CSS `4`
- Search: a Cloudflare Worker (Workers AI) running `bge-m3` semantic embeddings, `bge-reranker-base` cross-encoder rerank, and Lunr keyword search — no ML on the client
- AI SDK v6 + `@ai-sdk/react` + AI Elements · OpenRouter (`@openrouter/ai-sdk-provider`)
- `motion` animations · Lucide icons · Vercel hosting

## Local Development

```bash
npm install
npm run dev          # http://localhost:3000
npm run build        # production build
```

Environment variables (for the AI features) in `.env.local`:

```text
OPENROUTER_API_KEY=...        # server-side only
DIGEST_UNLOCK_SECRET=...      # passkey that unlocks AI Digest + chat
```

## Syncing Fresh Bookmarks

New bookmarks are pulled and **appended incrementally** (only what's new since the last sync) using the global `xrelay` CLI. Make sure it's up to date (needs `>= 1.4.0` for the `archive` command):

```bash
npm i -g x-relay-mcp@latest
```

Then, from the project root:

```bash
npm run sync
```

`sync` runs:

```bash
xrelay archive bookmarks --out public/data/all-bookmarks.json --limit 5000
node scripts/backfill-articles.mjs
node scripts/embed-new.mjs
```

- `xrelay archive bookmarks` fetches your bookmarks newest-first and stops once it hits already-archived IDs, prepending only the new ones. `--limit 5000` ensures the stop condition (not the default `40` cap) is what halts the pull.
- `scripts/backfill-articles.mjs` fetches the full article body (title + markdown) for any X Article bookmark that doesn't have one yet, via `xrelay`, and writes it into the archive in place. Idempotent — re-running only touches bookmarks with a still-empty article body — and exits `0` on ordinary single-item flakiness so it never fails a routine sync. This runs **before** embedding: a freshly-synced X Article has no body yet, and `embed-new.mjs` skips by id once a vector exists for a post, so an article embedded before its markdown lands would be text-only (no chunks) forever.
- `scripts/embed-new.mjs` embeds **only** the newly added posts and appends them to `search-index.json` (main vector, plus one chunk vector per ~280-word slice of any article body — index schema v2). Running it last means it sees each new X Article's full markdown already backfilled, so the chunk vectors are cut from real content on the first pass.

Then commit and push (Vercel redeploys on push to `main`):

```bash
git add public/data/all-bookmarks.json public/data/search-index.json
git commit -m "Sync fresh bookmarks"
git push
```

### Related scripts

```bash
npm run build:search     # full rebuild of search-index.json from all-bookmarks.json
npm run embed:new        # incremental embeddings only (no fetch)
npm run migrate:archive  # one-time: convert a legacy {data:[...]} export to ArchiveFile shape
npm run eval:search      # golden-query relevance scorecard (recall/mrr/ndcg) vs. scripts/eval-baseline.json
npm run test:search      # unit tests for the search pipeline (chunking, grouping, floors, rerank)
npm run test:operators   # unit tests for from:/before:/after: query-operator parsing
```

A global `bookmark-search` CLI (`scripts/bookmark-search.mjs`) also runs the same hybrid pipeline standalone over the committed archive/index — see that script's `--help` for usage; it's what backs the `bookmark-search` Claude Code skill outside this project.

## Deployment

The project is connected to Vercel and GitHub. Pushing to `main` updates production through Vercel's Git integration.

```bash
vercel --prod   # manual production deploy
```

## Notes

- The bookmark JSON is committed into the private repository (the data files are several MB; a large push may need `git config http.postBuffer 524288000`).
- Search runs server-side on a Cloudflare Worker that embeds/reranks with Workers AI and fetches its index data from the static JSON hosted on Vercel — still no database required at runtime.
- Favorites, digests, and chats are intentionally not synced across devices.
- The Vercel runtime server API exists only for the AI Digest, chat, and query-expansion endpoints — all three are passkey-gated and stateless (no database). Search itself is served separately by the Cloudflare Worker's `/search` endpoint (ungated, public) — see [Search architecture](#search-architecture).
