// Push the runtime search data + raw archive to the private R2 bucket the deployed Worker reads
// from (T8 lockdown). Run after a data refresh (`npm run sync` calls this last). Nothing is served
// from the public Vercel CDN — public/data/* is untracked and used only for local dev/eval.
//
// Versioned + atomic (2026-10): the four search files the Worker loads together are uploaded under
// `v/<version>/<name>` (version = content hash of the four), then `manifest.json` is written LAST
// and is the switch — the Worker (worker/src/index.ts) reads the manifest, so a half-finished
// upload can never be served as a mismatched set. Re-running with unchanged data is a no-op for
// the versioned set. The last KEEP_VERSIONS versions are kept (instant rollback = re-point the
// manifest); older ones are deleted. all-bookmarks.json (streamed by /archive, ETag-cached by the
// browser) and the search-index-bge.json backup keep their fixed keys and go up after the manifest.
//
// Requires Cloudflare auth: CLOUDFLARE_API_TOKEN (the autopilot provides it) or `wrangler login`.
// Prints a final JSON line { version, uploaded, pruned } for scripts/auto-sync.mjs.
//
// Usage: npm run upload:r2 [-- --force]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BUCKET = "bookmark-search-data";
const DATA = join(root, "public/data");
const KEEP_VERSIONS = 3;
const MAX_ATTEMPTS = 4;
const FORCE = process.argv.includes("--force");

// Loaded together by the Worker's loadData() — versioned. Keep in sync with worker/src/index.ts.
const SEARCH_ASSETS = [
  ["search-index-bge.meta.json", "application/json"],
  ["search-index-bge.bin", "application/octet-stream"],
  ["rerank-docs.json", "application/json"],
  ["lunr-index.json", "application/json"],
];
// Fixed keys, uploaded after the manifest switch.
const FIXED_ASSETS = [
  ["all-bookmarks.json", "application/json"], // /archive (handleArchive) + prepare-sync restore base
  // BACKUP-ONLY: the incremental-embed reuse base, restored by scripts/prepare-sync.mjs on a fresh disk.
  ["search-index-bge.json", "application/json"],
];

const log = (msg) => console.log(`[upload-r2] ${msg}`);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The repo-pinned wrangler (worker/package.json), not whatever `npx` would download today. */
function wrangler(args, opts = {}) {
  const pinned = join(root, "worker", "node_modules", ".bin", "wrangler");
  const [cmd, pre] = existsSync(pinned) ? [pinned, []] : ["npx", ["wrangler"]];
  return spawnSync(cmd, [...pre, ...args], { cwd: root, env: process.env, encoding: "utf8", ...opts });
}

/** One R2 object op with retries: Cloudflare intermittently answers a large PUT with a transient 5xx. */
function r2(op, key, extra = [], { quiet = false } = {}) {
  let res;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    res = wrangler(["r2", "object", op, `${BUCKET}/${key}`, ...extra, "--remote"], quiet ? {} : { stdio: ["ignore", "inherit", "pipe"] });
    if (res.status === 0) return res;
    const err = `${res.stderr ?? ""}`;
    if (/does not exist|not found|no such key|nosuchkey|10007/i.test(err)) return res; // definitive, don't retry
    if (/authentication|unauthorized|10000|9109/i.test(err)) break; // auth won't fix itself
    if (attempt < MAX_ATTEMPTS) {
      log(`${op} ${key}: attempt ${attempt} failed (exit ${res.status}) — retrying in ${attempt * 10}s`);
      sleep(attempt * 10_000);
    }
  }
  return res;
}

function fail(message, res) {
  console.error(`[upload-r2] FAILED: ${message}`);
  const detail = `${res?.stderr ?? ""}`.trim().split("\n").slice(-4).join("\n  ");
  if (detail) console.error(`  ${detail}`);
  console.error("  Cloudflare auth needed? npm run autosync -- doctor  (or: export CLOUDFLARE_API_TOKEN=…)");
  process.exit(1);
}

function readRemoteManifest(tmp) {
  const file = join(tmp, "manifest.remote.json");
  const res = r2("get", "manifest.json", ["--file", file], { quiet: true });
  if (res.status !== 0) {
    if (/does not exist|not found|no such key|nosuchkey|10007/i.test(`${res.stderr}`)) return null; // first versioned publish
    fail("could not read the current manifest.json", res);
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // unreadable manifest → treat as absent; this publish rewrites it
  }
}

for (const [name] of [...SEARCH_ASSETS, ...FIXED_ASSETS]) {
  const path = join(DATA, name);
  if (!existsSync(path) || statSync(path).size === 0) fail(`missing ${path} — run \`npm run sync\` first`);
}

const hash = createHash("sha256");
for (const [name] of SEARCH_ASSETS) hash.update(name).update(readFileSync(join(DATA, name)));
const version = hash.digest("hex").slice(0, 12);
const files = Object.fromEntries(SEARCH_ASSETS.map(([name]) => [name, `v/${version}/${name}`]));

const tmp = mkdtempSync(join(tmpdir(), "upload-r2-"));
let pruned = [];
let uploaded = false;
try {
  const current = readRemoteManifest(tmp);
  if (current?.version === version && !FORCE) {
    log(`search data v${version} is already live — skipping the versioned upload`);
  } else {
    for (const [name, contentType] of SEARCH_ASSETS) {
      const mb = (statSync(join(DATA, name)).size / 1e6).toFixed(1);
      log(`uploading ${name} (${mb} MB) → r2://${BUCKET}/${files[name]}`);
      const res = r2("put", files[name], ["--file", join(DATA, name), "--content-type", contentType]);
      if (res.status !== 0) fail(`upload of ${name}`, res); // manifest untouched → prod keeps the old set
    }
    const history = [version, ...(current?.history ?? (current?.version ? [current.version] : []))]
      .filter((v, i, all) => all.indexOf(v) === i);
    const manifest = { schema: 1, version, publishedAt: new Date().toISOString(), files, history: history.slice(0, KEEP_VERSIONS) };
    const manifestFile = join(tmp, "manifest.json");
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    log(`switching manifest.json → v${version}`);
    const res = r2("put", "manifest.json", ["--file", manifestFile, "--content-type", "application/json"]);
    if (res.status !== 0) fail("manifest switch", res);
    uploaded = true;

    // Prune versions that fell out of the history window (best-effort: a leftover costs only storage).
    for (const old of history.slice(KEEP_VERSIONS)) {
      for (const [name] of SEARCH_ASSETS) r2("delete", `v/${old}/${name}`, [], { quiet: true });
      pruned.push(old);
    }
    if (pruned.length) log(`pruned old versions: ${pruned.join(", ")}`);
  }

  for (const [name, contentType] of FIXED_ASSETS) {
    const mb = (statSync(join(DATA, name)).size / 1e6).toFixed(1);
    log(`uploading ${name} (${mb} MB) → r2://${BUCKET}/${name}`);
    const res = r2("put", name, ["--file", join(DATA, name), "--content-type", contentType]);
    if (res.status !== 0) fail(`upload of ${name}`, res);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

log(`done — search data v${version} live in r2://${BUCKET}`);
console.log(JSON.stringify({ version, uploaded, pruned }));
