// Push the runtime search data + raw archive to the private R2 bucket the deployed Worker reads
// from (T8 lockdown). Run after a data refresh (`npm run sync` calls this last) so prod picks up
// the new index/archive; the Worker reads these exact keys via the SEARCH_DATA binding, and
// /api/archive streams all-bookmarks.json to the logged-in browser. Nothing is served from the
// public Vercel CDN anymore — public/data/* is untracked (see .gitignore) and used only for local
// dev/eval. Idempotent: re-running overwrites each object in place.
//
// Requires Cloudflare auth (same as deploy:worker): `wrangler login` OR `export
// CLOUDFLARE_API_TOKEN=...`. No token is stored on disk by design; this fails fast if it's missing.
//
// Usage: npm run upload:r2
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUCKET = "bookmark-search-data";

// key = the filename stored in R2; value = content type. The first five are what the Worker fetches
// (worker/src/index.ts loadData() — the 4 search assets — + handleArchive — the archive). Keep those
// in sync with the Worker. The last one is BACKUP-ONLY.
const ASSETS = [
  ["search-index-bge.meta.json", "application/json"],
  ["search-index-bge.bin", "application/octet-stream"],
  ["rerank-docs.json", "application/json"],
  ["lunr-index.json", "application/json"],
  ["all-bookmarks.json", "application/json"],
  // BACKUP-ONLY: the Worker does NOT fetch this (it reads the packed .bin). Stored in R2 so the
  // incremental-embed reuse base survives a lost/fresh local disk — scripts/prepare-sync.mjs restores
  // it before a sync. Without this, a disk loss forces a full, costly re-embed of the whole corpus.
  ["search-index-bge.json", "application/json"],
];

function log(msg) {
  console.log(`[upload-r2] ${msg}`);
}

let failed = 0;
for (const [name, contentType] of ASSETS) {
  const filePath = join(root, "public/data", name);
  if (!existsSync(filePath)) {
    console.error(`[upload-r2] MISSING ${filePath} — run \`npm run sync\` first. Skipping.`);
    failed++;
    continue;
  }
  const mb = (statSync(filePath).size / 1e6).toFixed(1);
  log(`uploading ${name} (${mb} MB) → r2://${BUCKET}/${name}`);
  const res = spawnSync(
    "npx",
    [
      "wrangler",
      "r2",
      "object",
      "put",
      `${BUCKET}/${name}`,
      "--file",
      filePath,
      "--content-type",
      contentType,
      "--remote",
    ],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (res.status !== 0) {
    console.error(`[upload-r2] FAILED to upload ${name} (wrangler exit ${res.status}).`);
    // Surface the common cause without hanging: auth. wrangler already prints the detail above.
    if (res.status === null) {
      console.error("[upload-r2] wrangler did not run — is it installed / are you authenticated?");
    }
    failed++;
  }
}

if (failed > 0) {
  console.error(
    `\n[upload-r2] ${failed}/${ASSETS.length} upload(s) failed. Cloudflare auth needed?\n` +
      "  • cd worker && npx wrangler login      (browser OAuth)\n" +
      "  • export CLOUDFLARE_API_TOKEN=<token>   (this shell only)\n" +
      "Then re-run: npm run upload:r2",
  );
  process.exit(1);
}
log(`done — ${ASSETS.length} objects live in r2://${BUCKET}. Deploy the Worker if its code changed: npm run deploy:worker`);
