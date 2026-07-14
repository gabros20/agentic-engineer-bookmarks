# X Bookmarks

A Next.js app for browsing a personal archive of saved X bookmarks.

The app renders a static JSON export as searchable cards with local hybrid (keyword + semantic) search, sorting/filtering, starring, an AI Digest that summarizes search results, and a ⌘K AI chat that can search the archive — all bilingual (English / Magyar). Fresh bookmarks are pulled and appended incrementally with the [`xrelay`](https://github.com/gabros20/x-relay) CLI.

## Live App

- Production: <https://agentic-engineer-bookmarks.vercel.app>
- Repository: <https://github.com/gabros20/agentic-engineer-bookmarks>

## Data

Bookmark data and the semantic index live as static JSON:

```text
public/data/all-bookmarks.json   # the bookmark archive (xrelay ArchiveFile shape)
public/data/search-index.json    # int8 MiniLM embeddings, one per bookmark
```

Current export:

- `5,370` saved posts
- `186` X Article bookmarks
- `4,525` posts with media
- `2,414` posts with video/GIF media
- Source: X bookmarks fetched through [`xrelay`](https://github.com/gabros20/x-relay) (`x-relay-mcp`)

The archive file is in xrelay's native `ArchiveFile` shape (`{ schema: "x-relay/archive@1", source, generatedAt, count, tweets: [...] }`). The app's data layer (`lib/xrelay-archive.ts`) maps each `ArchiveTweet` to its render shape on load and also accepts the legacy `{ data: [...] }` shape, so it keeps working across formats.

The deployed app is static. Favorites, saved digests, saved chats, and language are personal to each browser:

```text
localStorage["agentic-engineer-bookmarks:favorites"]
localStorage["agentic-engineer-bookmarks:digests"]
localStorage["agentic-engineer-bookmarks:chats"]
localStorage["agentic-engineer-bookmarks:lang"]
```

## Features

- Hybrid search: local semantic embeddings (Transformers.js) fused with keyword matching (Lunr)
- Exact / Broad precision toggle
- Search by post text, author, handle, URL, article title, and quoted-post text
- Sort by newest, oldest, most bookmarked, or most liked; filter to starred / article / media / photo / video / text-only
- **AI Digest** — summarize the top search results into themes via OpenRouter (`gpt-5.4-nano`), cached in `localStorage` and reopenable from a saved list
- **⌘K AI chat** — ask questions; the agent searches your archive with browser-side tools (AI SDK v6 + AI Elements)
- Bilingual UI and AI output (English / Magyar) with flag switcher
- Star/unstar with local persistence; open the original post on `x.com`
- JSON parsed off the main thread in a Web Worker with skeleton loading
- Responsive, Anthropic-styled card layout

AI features (Digest + chat) are gated behind a passkey stored as a `DIGEST_UNLOCK_SECRET` cookie; the OpenRouter key (`OPENROUTER_API_KEY`) is server-side only.

## Stack

- Next.js `16` (App Router) · React `19` · Tailwind CSS `4`
- Transformers.js browser embeddings (`Xenova/all-MiniLM-L6-v2`) · Lunr keyword search
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
node scripts/embed-new.mjs
```

- `xrelay archive bookmarks` fetches your bookmarks newest-first and stops once it hits already-archived IDs, prepending only the new ones. `--limit 5000` ensures the stop condition (not the default `40` cap) is what halts the pull.
- `scripts/embed-new.mjs` embeds **only** the newly added posts and appends them to `search-index.json`.

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
```

## Deployment

The project is connected to Vercel and GitHub. Pushing to `main` updates production through Vercel's Git integration.

```bash
vercel --prod   # manual production deploy
```

## Notes

- The bookmark JSON is committed into the private repository (the data files are several MB; a large push may need `git config http.postBuffer 524288000`).
- Semantic search is static and Vercel-compatible — query embeddings run in the browser, so no database is required at runtime.
- Favorites, digests, and chats are intentionally not synced across devices.
- The runtime server API exists only for the AI Digest and chat endpoints.
