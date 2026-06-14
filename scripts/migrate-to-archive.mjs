// One-time migration: convert the legacy twitter-cli bookmark file
// ({ ok, schema_version, metadata, data: [...] }) into the xrelay-native
// ArchiveFile shape ({ schema, source, generatedAt, count, tweets: [...] }).
//
// After this runs, `xrelay archive bookmarks --out public/data/all-bookmarks.json`
// recognizes the existing tweet IDs and appends only NEW bookmarks incrementally
// (instead of clobbering the file with a fresh fetch). Idempotent: re-running on
// an already-migrated file is a no-op.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bookmarkToArchiveTweet, buildArchiveFile } from "./lib/archive.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const filePath = join(root, "public/data/all-bookmarks.json");

const raw = JSON.parse(await readFile(filePath, "utf8"));

if (Array.isArray(raw.tweets)) {
  console.log(`Already xrelay ArchiveFile shape (${raw.tweets.length} tweets) — nothing to do.`);
  process.exit(0);
}

const legacy = Array.isArray(raw.data) ? raw.data : [];
if (legacy.length === 0) {
  console.error("No `data` array found in the legacy file — aborting (refusing to write empty archive).");
  process.exit(1);
}

const tweets = legacy.map(bookmarkToArchiveTweet);
const generatedAt = raw.metadata?.generated_at ?? new Date().toISOString();
const file = buildArchiveFile(tweets, generatedAt);

// Back up the legacy file alongside, then overwrite in place.
await writeFile(`${filePath}.legacy.bak`, JSON.stringify(raw));
await writeFile(filePath, JSON.stringify(file));

console.log(
  `Migrated ${tweets.length} bookmarks → xrelay ArchiveFile (newestId ${file.newestId}). ` +
    `Backup at all-bookmarks.json.legacy.bak`,
);
