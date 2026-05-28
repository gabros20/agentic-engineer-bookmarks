# X Bookmarks

A small Next.js app for browsing saved X bookmarks.

The app renders a static JSON export as searchable cards, supports local hybrid semantic search, lets you sort and filter the collection, and stores starred posts in browser `localStorage`.

## Live App

- Production: <https://agentic-engineer-bookmarks.vercel.app>
- Repository: <https://github.com/gabros20/agentic-engineer-bookmarks>

## Data

Bookmark data lives at:

```text
public/data/all-bookmarks.json
```

The semantic search index lives at:

```text
public/data/search-index.json
```

Current export:

- `4,610` saved posts
- `112` X Article bookmarks
- `3,883` posts with media
- `2,001` posts with video/GIF media
- Generated at `2026-05-27T19:40:10+00:00`
- Source: X bookmarks fetched through `twitter-cli`

The deployed app is static. Favorites are personal to each browser and are saved under:

```text
localStorage["agentic-engineer-bookmarks:favorites"]
```

## Features

- Hybrid search with local semantic embeddings plus keyword matching
- Search by post text, author, handle, URL, article title, and quoted post text
- Sort by newest, oldest, most bookmarked, or most liked
- Filter to starred, article, media, photo, video, or text-only posts
- Load the full archive in browser-friendly chunks
- Star/unstar posts with local persistence
- Open the original post on `x.com`
- Responsive card layout built with Tailwind CSS

## Stack

- Next.js `16.2.6`
- React `19.2.6`
- Tailwind CSS `4`
- Transformers.js browser embeddings
- Lunr keyword search
- Lucide React icons
- Vercel hosting

## Local Development

Install dependencies:

```bash
npm install
```

Run the dev server:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

To run on the same port used during setup:

```bash
npm run dev -- --port 4173
```

Build for production:

```bash
npm run build
```

Rebuild the semantic search index after changing bookmark data:

```bash
npm run build:search
```

## Deployment

The project is connected to Vercel and GitHub. Pushing to `main` updates the production project through Vercel's Git integration.

Manual production deploy:

```bash
vercel --prod
```

## Updating The Bookmark Export

Replace the static JSON file:

```text
public/data/all-bookmarks.json
```

Then rebuild:

```bash
npm run build:search
npm run build
```

Commit and push:

```bash
git add public/data/all-bookmarks.json public/data/search-index.json
git commit -m "Update bookmark export"
git push
```

## Notes

- The bookmark JSON is committed into the private repository.
- Semantic search is static and Vercel-compatible. The app loads `search-index.json` and runs query embeddings in the browser, so no database or paid API is required.
- Favorites are intentionally not synced across devices.
- The app does not require any server API at runtime.
