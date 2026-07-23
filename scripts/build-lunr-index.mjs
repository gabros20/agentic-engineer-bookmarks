// Serialize the lunr keyword index for the server-side (Cloudflare Worker) search — Task 1.
// The Worker will `lunr.Index.load(JSON.parse(...))` this instead of rebuilding lunr in the
// browser on every page load. buildKeywordIndex is IMPORTED from scripts/lib/search-core.mjs
// (Task 3, F2 drift fix) rather than hand-copied a second time — search-core.mjs is itself
// the existing Node port of lib/bookmark-search.ts's buildKeywordIndex (used by
// scripts/eval-search.mjs and asserted against the TS source by the drift guard in
// scripts/test-search-core.mjs), so there is now exactly ONE .mjs copy of this logic instead
// of two independently hand-maintained ones.
//
// Uses the repo-root lunr (2.3.9) — the serialized JSON embeds `"version":"2.3.9"`, and
// lunr.Index.load warns on a version mismatch, so the Worker (Task 2) must load with the
// same lunr major/minor.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBookmarkPayload } from "./lib/archive.mjs";
import { buildKeywordIndex } from "./lib/search-core.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePath = join(root, "public/data/all-bookmarks.json");
const outputPath = join(root, "public/data/lunr-index.json");

const payload = JSON.parse(await readFile(sourcePath, "utf8"));
const posts = normalizeBookmarkPayload(payload);
const index = buildKeywordIndex(posts);
await writeFile(outputPath, JSON.stringify(index.toJSON()));
console.log(`Wrote ${outputPath} — serialized lunr index over ${posts.length} posts.`);
