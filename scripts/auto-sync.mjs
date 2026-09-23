#!/usr/bin/env node
// Unattended bookmark sync — the autopilot wrapper around the SAME steps as `npm run sync`
// (prepare-sync → xrelay archive → backfill-articles → sync-bge → upload-r2). Run by launchd daily
// (`npm run autosync -- install`), or by hand: `npm run autosync:run [-- --dry-run]`.
//
// What it adds on top of `npm run sync`, because nobody is watching:
//   • single-instance lock (a slow run can't overlap the next one or a manual sync)
//   • auth from the Keychain: CLOUDFLARE_API_TOKEN (wrangler OAuth expires and can't be refreshed
//     non-interactively) — falls back to an existing `wrangler login` if no token is stored
//   • preflight: X auth (`xrelay whoami`) + Cloudflare auth (`wrangler whoami`) BEFORE touching data
//   • truncation guard: all-bookmarks.json is backed up before the pull; if the archive SHRINKS, the
//     backup is restored and the run fails (never upload a truncated corpus to prod)
//   • per-step timeouts + retries for the network-bound steps; a flaky article backfill is a warning
//   • upload skipped when nothing changed (content hashes of the six R2 objects)
//   • run record in ~/Library/Logs/xbookmarks-sync/last-run.json + a log per run; macOS notification
//
// Flags: --dry-run (preflight only) · --force-upload · --no-notify · --update-xrelay
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  LAST_RUN_PATH,
  LOCK_PATH,
  LOG_DIR,
  REPO_ROOT,
  loadConfig,
  readEnvFile,
  resolveCloudflareToken,
} from "./lib/autosync-config.mjs";

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const FORCE_UPLOAD = args.has("--force-upload");
const NO_NOTIFY = args.has("--no-notify");

const DATA = join(REPO_ROOT, "public", "data");
const ARCHIVE = join(DATA, "all-bookmarks.json");
const ARCHIVE_BACKUP = join(DATA, "all-bookmarks.json.autosync-bak");
// The six objects upload-r2.mjs pushes — their combined hash decides whether an upload is needed.
const R2_ASSETS = [
  "search-index-bge.meta.json",
  "search-index-bge.bin",
  "rerank-docs.json",
  "lunr-index.json",
  "all-bookmarks.json",
  "search-index-bge.json",
];
const MIN = 60_000;

const config = loadConfig();
const startedAt = new Date();
mkdirSync(LOG_DIR, { recursive: true });
const logPath = join(LOG_DIR, `sync-${startedAt.toISOString().replace(/[:.]/g, "-")}.log`);
const logFile = createWriteStream(logPath, { flags: "a" });

function log(message) {
  const line = `[auto-sync ${new Date().toISOString()}] ${message}`;
  console.log(line);
  logFile.write(`${line}\n`);
}

// ------------------------------------------------------------------ helpers

/** Run a command, teeing output to the console + run log. Resolves { code, output }; kills on timeout. */
function run(cmd, cmdArgs, { timeoutMs, env }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let output = "";
    const onData = (chunk) => {
      output += chunk;
      if (output.length > 200_000) output = output.slice(-100_000);
      process.stdout.write(chunk);
      logFile.write(chunk);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      log(`timeout after ${Math.round(timeoutMs / MIN)} min — killing ${cmd}`);
      try {
        process.kill(-child.pid, "SIGTERM"); // whole group: sync-bge spawns wrangler/workerd
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: `${output}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
  });
}

async function withRetry(label, attempts, delayMs, fn) {
  for (let attempt = 1; ; attempt += 1) {
    const result = await fn();
    if (result.code === 0 || attempt >= attempts) return result;
    log(`${label} failed (exit ${result.code}) — retry ${attempt}/${attempts - 1} in ${Math.round(delayMs / 1000)}s`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

function archiveStats() {
  if (!existsSync(ARCHIVE)) return { count: 0, newestId: null };
  try {
    const raw = JSON.parse(readFileSync(ARCHIVE, "utf8"));
    const items = Array.isArray(raw.tweets) ? raw.tweets : Array.isArray(raw.data) ? raw.data : [];
    return { count: items.length, newestId: raw.newestId ?? items[0]?.id ?? null };
  } catch {
    return { count: -1, newestId: null }; // unreadable = treat as corrupt
  }
}

function dataFingerprint() {
  const hash = createHash("sha256");
  for (const name of R2_ASSETS) {
    const path = join(DATA, name);
    hash.update(name);
    if (!existsSync(path)) {
      hash.update("missing");
    } else if (name === "all-bookmarks.json") {
      // xrelay restamps `generatedAt` on every pull, even when no bookmark changed — ignore it, or
      // every no-op day would re-upload 6 objects (~70 MB) to R2.
      const { generatedAt: _ignored, ...rest } = JSON.parse(readFileSync(path, "utf8"));
      hash.update(JSON.stringify(rest));
    } else {
      hash.update(readFileSync(path));
    }
  }
  return hash.digest("hex");
}

function notify(title, message) {
  if (NO_NOTIFY || config.notify === "never") return;
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  spawnSync("/usr/bin/osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"`]);
}

function acquireLock() {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  if (existsSync(LOCK_PATH)) {
    const pid = Number(readFileSync(LOCK_PATH, "utf8").trim());
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    if (alive) return false;
    log(`removing stale lock (pid ${pid} is gone)`);
  }
  writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}

function releaseLock() {
  try {
    if (existsSync(LOCK_PATH) && readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

function pruneLogs() {
  const logs = readdirSync(LOG_DIR)
    .filter((f) => /^sync-.*\.log$/.test(f))
    .sort();
  for (const old of logs.slice(0, Math.max(0, logs.length - config.keepLogs))) rmSync(join(LOG_DIR, old));
}

// ------------------------------------------------------------------ environment

function buildEnv() {
  // The env file fills in (never overrides) the real environment: tokens + XRELAY_COOKIES for headless boxes.
  const { vars: fileVars, warning: envFileWarning } = readEnvFile();
  const envFileKeys = new Set(Object.keys(fileVars).filter((k) => process.env[k] === undefined));
  const env = { ...fileVars, ...process.env };
  if (envFileWarning) {
    record.warnings.push(envFileWarning);
    log(`⚠ ${envFileWarning}`);
  }
  // launchd starts with a bare PATH. The node running this script is the one whose global bin also
  // holds npx + xrelay (fnm/nvm install layout), so put its directory first.
  const nodeBin = dirname(process.execPath);
  env.PATH = [nodeBin, env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .filter(Boolean)
    .join(":");
  env.CI = "1"; // no interactive prompts from npm/wrangler
  env.WRANGLER_SEND_METRICS = "false";
  const { token, source: cfAuth, warnings = [] } = resolveCloudflareToken(config, env, envFileKeys);
  if (token) env.CLOUDFLARE_API_TOKEN = token;
  for (const w of warnings) {
    record.warnings.push(w);
    log(`⚠ ${w}`);
  }
  if (config.cloudflareAccountId && !env.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = config.cloudflareAccountId;
  if (config.xrelayBrowser && !env.XRELAY_BROWSER) env.XRELAY_BROWSER = config.xrelayBrowser;
  return { env, cfAuth };
}

/**
 * sync-bge's throwaway `wrangler dev` gates its /embed route with EMBED_SECRET from worker/.dev.vars
 * (gitignored). On a fresh clone (e.g. a Mac mini server) the file doesn't exist and every embed 403s.
 * The secret only guards a localhost dev server that lives for one run, so mint a random one if absent.
 */
function ensureEmbedSecret() {
  const devVars = join(REPO_ROOT, "worker", ".dev.vars");
  const text = existsSync(devVars) ? readFileSync(devVars, "utf8") : "";
  if (/^\s*EMBED_SECRET\s*=\s*\S/m.test(text)) return;
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  appendFileSync(devVars, `${prefix}EMBED_SECRET=${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
  log("created EMBED_SECRET in worker/.dev.vars (local-only secret for the embed step)");
}

// ------------------------------------------------------------------ main

const record = {
  startedAt: startedAt.toISOString(),
  finishedAt: null,
  ok: false,
  dryRun: DRY_RUN,
  before: null,
  after: null,
  added: 0,
  uploaded: false,
  warnings: [],
  steps: [],
  error: null,
  log: logPath,
};

function writeRecord() {
  record.finishedAt = new Date().toISOString();
  writeFileSync(LAST_RUN_PATH, `${JSON.stringify(record, null, 2)}\n`);
}

class StepError extends Error {}

async function step(name, fn, { fatal = true } = {}) {
  const t0 = Date.now();
  log(`▶ ${name}`);
  const result = await fn();
  const ok = result.code === 0;
  record.steps.push({ name, ok, ms: Date.now() - t0 });
  if (!ok) {
    const tail = result.output.trim().split("\n").slice(-3).join(" | ");
    if (fatal) throw new StepError(`${name} failed (exit ${result.code}): ${tail}`);
    record.warnings.push(`${name} failed (exit ${result.code}) — continuing`);
    log(`⚠ ${name} failed (non-fatal) — continuing`);
  }
  return result;
}

async function main() {
  if (!acquireLock()) {
    log("another sync is running — exiting");
    record.error = "locked";
    return 0; // not a failure; the other run will report
  }
  const { env, cfAuth } = buildEnv();
  const node = process.execPath;
  const npx = join(dirname(process.execPath), "npx");
  log(
    `repo ${REPO_ROOT} · node ${process.version} · Cloudflare auth via ${cfAuth} · X cookies via ${env.XRELAY_COOKIES ? "XRELAY_COOKIES" : "browser"}${DRY_RUN ? " · DRY RUN" : ""}`,
  );

  // --- preflight: fail fast, before anything touches the data
  if (args.has("--update-xrelay") || config.updateXrelay) {
    await step("update xrelay", () => run(join(dirname(npx), "npm"), ["i", "-g", "x-relay-mcp@latest"], { timeoutMs: 5 * MIN, env }), { fatal: false });
  }
  await step("preflight: X auth (xrelay whoami)", () =>
    withRetry("xrelay whoami", 3, 30_000, () => run("xrelay", ["whoami"], { timeoutMs: 2 * MIN, env })),
  );
  await step("preflight: Cloudflare auth (wrangler whoami)", async () => {
    const res = await run(npx, ["--yes", "wrangler", "whoami"], { timeoutMs: 3 * MIN, env });
    return /not (logged in|authenticated)|could not be refreshed/i.test(res.output) ? { ...res, code: res.code || 1 } : res;
  });

  record.before = archiveStats();
  log(`archive before: ${record.before.count} bookmarks`);
  if (DRY_RUN) {
    record.ok = true;
    log("dry run — preflight passed, stopping before any data step");
    return 0;
  }

  ensureEmbedSecret();
  const fingerprintBefore = dataFingerprint();

  await step("prepare-sync (restore inputs from R2 if missing)", () =>
    run(node, ["scripts/prepare-sync.mjs"], { timeoutMs: 10 * MIN, env }),
  );

  // Truncation guard, part 1: keep the pre-pull archive.
  const beforePull = archiveStats();
  if (existsSync(ARCHIVE)) copyFileSync(ARCHIVE, ARCHIVE_BACKUP);

  await step("xrelay archive bookmarks (incremental pull)", () =>
    withRetry("xrelay archive", 3, 60_000, () =>
      run("xrelay", ["archive", "bookmarks", "--out", ARCHIVE, "--limit", "10000"], { timeoutMs: 20 * MIN, env }),
    ),
  );

  // Truncation guard, part 2: the archive must never shrink or become unreadable.
  const afterPull = archiveStats();
  if (afterPull.count < beforePull.count) {
    if (existsSync(ARCHIVE_BACKUP)) renameSync(ARCHIVE_BACKUP, ARCHIVE);
    throw new StepError(
      `archive shrank ${beforePull.count} → ${afterPull.count} after the pull — restored the backup, nothing uploaded`,
    );
  }
  if (existsSync(ARCHIVE_BACKUP)) rmSync(ARCHIVE_BACKUP);
  log(`pulled: ${afterPull.count - beforePull.count} new bookmark(s)`);

  await step("backfill X Article bodies", () => run(node, ["scripts/backfill-articles.mjs"], { timeoutMs: 20 * MIN, env }), {
    fatal: false, // a flaky article is retried tomorrow; don't block today's new bookmarks
  });
  await step("sync-bge (embed new posts + rebuild search artifacts)", () =>
    run(node, ["scripts/sync-bge.mjs"], { timeoutMs: 30 * MIN, env }),
  );

  record.after = archiveStats();
  record.added = Math.max(0, record.after.count - record.before.count);

  if (FORCE_UPLOAD || dataFingerprint() !== fingerprintBefore) {
    await step("upload-r2 (publish to prod)", () => run(node, ["scripts/upload-r2.mjs"], { timeoutMs: 15 * MIN, env }));
    record.uploaded = true;
  } else {
    log("no data changed — skipping upload");
  }

  record.ok = true;
  log(`done: +${record.added} (total ${record.after.count})${record.uploaded ? ", published to R2" : ""}`);
  return 0;
}

/** A pull that failed midway must not leave a smaller/corrupt archive behind for the next run. */
function settleArchiveBackup(backupCount) {
  if (!existsSync(ARCHIVE_BACKUP)) return;
  const now = archiveStats();
  if (now.count < backupCount) {
    renameSync(ARCHIVE_BACKUP, ARCHIVE);
    log(`restored all-bookmarks.json from the pre-pull backup (${now.count} < ${backupCount})`);
  } else {
    rmSync(ARCHIVE_BACKUP);
  }
}

let exitCode = 0;
try {
  exitCode = await main();
} catch (err) {
  exitCode = 1;
  record.error = err instanceof Error ? err.message : String(err);
  log(`✖ ${record.error}`);
  try {
    if (existsSync(ARCHIVE_BACKUP)) {
      const raw = JSON.parse(readFileSync(ARCHIVE_BACKUP, "utf8"));
      settleArchiveBackup((raw.tweets ?? raw.data ?? []).length);
    }
  } catch (restoreErr) {
    log(`could not settle the archive backup: ${restoreErr.message}`);
  }
} finally {
  writeRecord();
  releaseLock();
  try {
    pruneLogs();
  } catch {
    /* ignore */
  }
}

if (record.error && record.error !== "locked") {
  notify("X Bookmarks sync failed", `${record.error.slice(0, 180)} — see ${LOG_DIR}`);
} else if (record.ok && !DRY_RUN && (config.notify === "always" || (config.notify === "changes" && record.added > 0))) {
  notify("X Bookmarks synced", record.added > 0 ? `+${record.added} new bookmarks (total ${record.after.count})` : "No new bookmarks");
}
logFile.end();
// Exit explicitly so a lingering child handle can never keep launchd's job "running".
process.exit(exitCode);
