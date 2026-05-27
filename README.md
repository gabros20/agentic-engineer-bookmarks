# Claude Code Bookmarks

A small Next.js app for browsing Claude Code-related posts saved from X bookmarks.

The app renders a static JSON export as searchable cards, lets you sort and filter the collection, and stores starred posts in browser `localStorage`.

## Live App

- Production: <https://claude-code-bookmarks.vercel.app>
- Repository: <https://github.com/gabros20/claude-code-bookmarks>

## Data

Bookmark data lives at:

```text
public/data/claude-code-bookmarks.json
```

Current export:

- `306` Claude Code-related bookmark matches
- `4,610` total bookmarks scanned
- Generated at `2026-05-27T19:40:10+00:00`
- Source: X bookmarks fetched through `twitter-cli`

The deployed app is static. Favorites are personal to each browser and are saved under:

```text
localStorage["claude-code-bookmarks:favorites"]
```

## Features

- Search by post text, author, handle, URL, article title, and quoted post text
- Sort by newest, oldest, most bookmarked, or most liked
- Filter to starred posts
- Star/unstar posts with local persistence
- Open the original post on `x.com`
- Responsive card layout built with Tailwind CSS

## Stack

- Next.js `16.2.6`
- React `19.2.6`
- Tailwind CSS `4`
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

## Deployment

The project is connected to Vercel and GitHub. Pushing to `main` updates the production project through Vercel's Git integration.

Manual production deploy:

```bash
vercel --prod
```

## Updating The Bookmark Export

Replace the static JSON file:

```text
public/data/claude-code-bookmarks.json
```

Then rebuild:

```bash
npm run build
```

Commit and push:

```bash
git add public/data/claude-code-bookmarks.json
git commit -m "Update bookmark export"
git push
```

## Notes

- The bookmark JSON is committed into the private repository.
- Favorites are intentionally not synced across devices.
- The app does not require any server API at runtime.
