#!/usr/bin/env node
// Unattended bookmark sync — the autopilot around the SAME steps as `npm run sync`
// (prepare-sync → xrelay archive → backfill-articles → sync-bge → upload-r2). launchd runs it every
// hour + at login with --scheduled (`npm run autosync -- install`); by hand: `npm run autosync:run`.
//
// Built to fix itself, because nobody is watching:
//   • scheduling (lib/sync-state.mjs): a tick only RUNS when due — once a day from config.hour:minute,
//     retried every config.retryHours after a failure (max config.maxAttemptsPerDay), a missed day is
//     caught up at the next wake/login, offline ticks don't burn attempts. `autosync -- run` forces one.
//   • atomic O_EXCL lock; `caffeinate` keeps the Mac awake for the run
//   • preflight before touching data: disk space, network, X auth (xrelay whoami), Cloudflare token
//     (API verify, not a 20-second `npx wrangler whoami`), account id auto-resolved + cached
//   • xrelay self-update at most weekly, only when npm has a newer version, rolled back if X auth breaks
//   • embedding via Workers AI REST (no local server/port — lib/embed-transport.mjs); sync-bge retried once
//   • truncation guard: all-bookmarks.json backed up before the pull, restored if the archive shrinks
//   • publish when local data differs from what was LAST PUBLISHED (not from the start of this run, so
//     a failed upload is retried next time), versioned + manifest switch (upload-r2.mjs), then verified
//     against the live Worker (x-data-version) when config.workerUrl is set
//   • failures classified (lib/sync-errors.mjs) → one notification per cause per day with the actual
//     fix, only when retrying won't help or it's the day's last attempt; "no sync for N days" alert
//   • branded clickable notifications + a status page (lib/notifier.mjs); runs.jsonl history
//
// Flags: --scheduled (launchd tick) · --dry-run (preflight only) · --force-upload · --no-notify
//        · --update-xrelay (check now) · --embed=rest|local
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
  statfsSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  CONFIG_DIR,
  LAST_RUN_PATH,
  LOCK_PATH,
  LOG_DIR,
  REPO_ROOT,
  RUN_NOW_MARKER,
  RUNS_PATH,
  STATE_PATH,
  loadConfig,
  readEnvFile,
  readRepoEnvLocal,
  resolveCloudflareToken,
  saveConfig,
} from "./lib/autosync-config.mjs";
import { resolveAccountId } from "./lib/embed-transport.mjs";
import { computeHealth, notify as postNotification, readLogTail, writeStatusPage } from "./lib/notifier.mjs";
import { classifyError } from "./lib/sync-errors.mjs";
import {
  acquireLock,
  appendRun,
  formatWhen,
  loadState,
  localDay,
  nextRunAt,
  readRuns,
  releaseLock,
  rollDay,
  saveState,
  shouldRun,
  shouldUpload,
} from "./lib/sync-state.mjs";

const argv = process.argv.slice(2);
const args = new Set(argv);
const SCHEDULED = args.has("--scheduled");
const DRY_RUN = args.has("--dry-run");
const FORCE_UPLOAD = args.has("--force-upload");
const NO_NOTIFY = args.has("--no-notify");
const EMBED = argv.find((a) => a.startsWith("--embed="))?.split("=")[1];

const DATA = join(REPO_ROOT, "public", "data");
const ARCHIVE = join(DATA, "all-bookmarks.json");
const ARCHIVE_BACKUP = join(DATA, "all-bookmarks.json.autosync-bak");
// The objects upload-r2.mjs publishes — their combined hash decides whether an upload is needed.
const R2_ASSETS = [
  "search-index-bge.meta.json",
  "search-index-bge.bin",
  "rerank-docs.json",
  "lunr-index.json",
  "all-bookmarks.json",
  "search-index-bge.json",
];
const MIN = 60_000;
const DAY = 86_400_000;
const MIN_FREE_BYTES = 1e9;

const config = loadConfig();
const state = loadState(STATE_PATH);
const now = new Date();
mkdirSync(LOG_DIR, { recursive: true });
mkdirSync(CONFIG_DIR, { recursive: true });

// ------------------------------------------------------------------ notifications + status page

function notify(kind, title, message, subtitle = "") {
  if (NO_NOTIFY || config.notify === "never") return;
  if (kind === "success" && config.notify === "failure") return;
  postNotification({ title, subtitle, message });
}

const nextAttemptLabel = () => formatWhen(nextRunAt(state, config));

function lastRunLog() {
  try {
    return JSON.parse(readFileSync(LAST_RUN_PATH, "utf8")).log ?? "";
  } catch {
    return "";
  }
}

function refreshStatusPage(logPath) {
  try {
    writeStatusPage({
      state,
      runs: readRuns(RUNS_PATH, 20),
      config,
      health: computeHealth(state, config),
      nextAttempt: nextAttemptLabel(),
      logTail: readLogTail(logPath ?? lastRunLog(), 80),
    });
  } catch (err) {
    console.error(`[auto-sync] could not write the status page: ${err.message}`);
  }
}

/** "No sync for N days" — at most once a day, from any tick. */
function staleCheck() {
  const last = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : null;
  const days = last ? (Date.now() - last) / DAY : Infinity;
  if (days < config.staleDays || !Number.isFinite(days)) return;
  if (state.staleNotifiedAt && Date.now() - Date.parse(state.staleNotifiedAt) < DAY) return;
  state.staleNotifiedAt = new Date().toISOString();
  saveState(STATE_PATH, state);
  const why = state.lastFailure ? `${state.lastFailure.title} — ${state.lastFailure.hint}` : "Click for details.";
  notify("failure", `No bookmark sync for ${Math.floor(days)} days`, why);
}

// ------------------------------------------------------------------ scheduled tick: run or skip

function trimLaunchdLogs() {
  for (const name of ["launchd.out.log", "launchd.err.log"]) {
    const path = join(LOG_DIR, name);
    try {
      if (existsSync(path) && statSync(path).size > 2e6) truncateSync(path, 0);
    } catch {
      /* ignore */
    }
  }
}

trimLaunchdLogs();
let forced = false;
if (existsSync(RUN_NOW_MARKER)) {
  forced = true; // `npm run autosync -- run`: one run regardless of the schedule
  rmSync(RUN_NOW_MARKER, { force: true });
}
if (SCHEDULED && !forced && !DRY_RUN) {
  rollDay(state, now);
  const decision = shouldRun(state, config, now);
  if (!decision.run) {
    console.log(`[auto-sync ${now.toISOString()}] skip: ${decision.reason}`);
    staleCheck();
    refreshStatusPage(null);
    process.exit(0);
  }
  console.log(`[auto-sync ${now.toISOString()}] run: ${decision.reason}`);
}

const lock = acquireLock(LOCK_PATH);
if (!lock.ok) {
  console.log(`[auto-sync ${now.toISOString()}] another sync is running (pid ${lock.holder?.pid ?? "?"}) — exiting`);
  process.exit(0);
}

// ------------------------------------------------------------------ run log + helpers

const logPath = join(LOG_DIR, `sync-${now.toISOString().replace(/[:.]/g, "-")}.log`);
const logFile = createWriteStream(logPath, { flags: "a" });

function log(message) {
  const line = `[auto-sync ${new Date().toISOString()}] ${message}`;
  console.log(line);
  logFile.write(`${line}\n`);
}

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
    let killTimer;
    const timer = setTimeout(() => {
      log(`timeout after ${Math.round(timeoutMs / MIN)} min — stopping ${cmd}`);
      const signal = (sig) => {
        try {
          process.kill(-child.pid, sig); // the whole group: sync-bge may have a wrangler/workerd child
        } catch {
          /* already gone */
        }
      };
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), 15_000);
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code: 127, output: `${output}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code: code ?? 1, output });
    });
  });
}

async function withRetry(label, attempts, delayMs, fn, { final } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const result = await fn();
    if (result.code === 0 || attempt >= attempts) return result;
    if (final?.test(result.output)) return result; // a definitive answer (e.g. "not logged in"): retrying can't change it
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
      // xrelay restamps `generatedAt` on every pull, even when no bookmark changed — ignore it.
      const { generatedAt: _ignored, ...rest } = JSON.parse(readFileSync(path, "utf8"));
      hash.update(JSON.stringify(rest));
    } else {
      hash.update(readFileSync(path));
    }
  }
  return hash.digest("hex");
}

function pruneLogs() {
  const logs = readdirSync(LOG_DIR)
    .filter((f) => /^sync-.*\.log$/.test(f))
    .sort();
  for (const old of logs.slice(0, Math.max(0, logs.length - config.keepLogs))) rmSync(join(LOG_DIR, old));
}

// ------------------------------------------------------------------ environment

const record = {
  startedAt: now.toISOString(),
  finishedAt: null,
  ok: false,
  dryRun: DRY_RUN,
  forced,
  before: null,
  after: null,
  added: 0,
  uploaded: false,
  version: null,
  warnings: [],
  steps: [],
  error: null,
  code: null,
  log: logPath,
};

function warn(message) {
  record.warnings.push(message);
  log(`⚠ ${message}`);
}

function buildEnv() {
  // The env file fills in (never overrides) the real environment: tokens + XRELAY_COOKIES for headless boxes.
  const { vars: fileVars, warning: envFileWarning } = readEnvFile();
  const envFileKeys = new Set(Object.keys(fileVars).filter((k) => process.env[k] === undefined));
  const env = { ...fileVars, ...process.env };
  if (envFileWarning) warn(envFileWarning);
  // launchd starts with a bare PATH. The node running this script is the one whose global bin also
  // holds npm + xrelay (fnm/nvm install layout), so put its directory first.
  env.PATH = [dirname(process.execPath), env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    .filter(Boolean)
    .join(":");
  env.CI = "1"; // no interactive prompts from npm/wrangler
  env.WRANGLER_SEND_METRICS = "false";
  const { token, source: cfAuth, warnings = [] } = resolveCloudflareToken(config, env, envFileKeys);
  if (token) env.CLOUDFLARE_API_TOKEN = token;
  for (const w of warnings) warn(w);
  if (config.cloudflareAccountId && !env.CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = config.cloudflareAccountId;
  if (config.xrelayBrowser && !env.XRELAY_BROWSER) env.XRELAY_BROWSER = config.xrelayBrowser;
  if (EMBED) env.EMBED_TRANSPORT = EMBED;
  return { env, cfAuth };
}

/** The local-fallback `wrangler dev` gates /embed with EMBED_SECRET from worker/.dev.vars (gitignored). */
function ensureEmbedSecret() {
  const devVars = join(REPO_ROOT, "worker", ".dev.vars");
  const text = existsSync(devVars) ? readFileSync(devVars, "utf8") : "";
  if (/^\s*EMBED_SECRET\s*=\s*\S/m.test(text)) return;
  const prefix = text && !text.endsWith("\n") ? "\n" : "";
  appendFileSync(devVars, `${prefix}EMBED_SECRET=${randomBytes(24).toString("hex")}\n`, { mode: 0o600 });
  log("created EMBED_SECRET in worker/.dev.vars (local-only secret for the fallback embed path)");
}

// ------------------------------------------------------------------ steps

class StepError extends Error {
  constructor(message, output = "") {
    super(message);
    this.output = output;
  }
}

async function step(name, fn, { fatal = true } = {}) {
  const t0 = Date.now();
  log(`▶ ${name}`);
  const result = await fn();
  const ok = result.code === 0;
  record.steps.push({ name, ok, ms: Date.now() - t0 });
  if (!ok) {
    const tail = result.output.trim().split("\n").slice(-3).join(" | ");
    if (fatal) throw new StepError(`${name} failed (exit ${result.code}): ${tail}`, result.output.slice(-4000));
    warn(`${name} failed (exit ${result.code}) — continuing`);
  }
  return result;
}

function checkDisk() {
  const fs = statfsSync(REPO_ROOT);
  const free = fs.bavail * fs.bsize;
  if (free < MIN_FREE_BYTES) throw new StepError(`low disk: only ${Math.round(free / 1e6)} MB free (need 1 GB)`);
}

async function checkNetwork() {
  const failures = [];
  for (const url of ["https://api.cloudflare.com/client/v4/", "https://x.com/"]) {
    try {
      await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
      return; // any HTTP answer means we're online
    } catch (err) {
      failures.push(`${new URL(url).host}: ${err?.cause?.code ?? err.name}`);
    }
  }
  throw new StepError(`offline — network unreachable (${failures.join(", ")})`);
}

/** Cloudflare token + account, via the API (sub-second) instead of `npx wrangler whoami`. */
async function checkCloudflare(env) {
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new StepError("Cloudflare auth: no CLOUDFLARE_API_TOKEN configured — run: npm run autosync -- set-token");
  const auth = { authorization: `Bearer ${token}` };
  let res = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: auth, signal: AbortSignal.timeout(20_000) });
  if (!res.ok && env.CLOUDFLARE_ACCOUNT_ID) {
    // Account-owned tokens verify under the account, not the user.
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/tokens/verify`, { headers: auth, signal: AbortSignal.timeout(20_000) });
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.result?.status !== "active") {
    throw new StepError(`Cloudflare rejected the token (HTTP ${res.status}${body?.result?.status ? `, ${body.result.status}` : ""})`);
  }
  const account = await resolveAccountId(token, env.CLOUDFLARE_ACCOUNT_ID);
  if (account.error) throw new StepError(`Cloudflare auth: ${account.error}`);
  env.CLOUDFLARE_ACCOUNT_ID = account.accountId;
  if (config.cloudflareAccountId !== account.accountId) {
    saveConfig({ ...loadConfig(), cloudflareAccountId: account.accountId }); // cache for next time
    log(`cached Cloudflare account ${account.accountId}`);
  }
  log(`Cloudflare token active · account ${account.accountId}`);
}

/** xrelay ≥ 1.7.0 captures the author's thread of each post (archive --threads / repair --threads). */
const THREADS_MIN_XRELAY = [1, 7, 0];
function supportsThreads(version) {
  const parts = String(version ?? "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] ?? 0) !== THREADS_MIN_XRELAY[i]) return (parts[i] ?? 0) > THREADS_MIN_XRELAY[i];
  }
  return true;
}

function installedXrelayVersion(env) {
  const npm = join(dirname(process.execPath), "npm");
  const rootRes = spawnSync(npm, ["root", "-g"], { encoding: "utf8", env });
  try {
    return JSON.parse(readFileSync(join(rootRes.stdout.trim(), "x-relay-mcp", "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/** At most weekly: install a newer xrelay only if npm has one, and roll back if X auth breaks. */
async function maybeUpdateXrelay(env) {
  const explicit = args.has("--update-xrelay");
  if (!config.updateXrelay && !explicit) return;
  if (!explicit && state.lastXrelayCheckAt && Date.now() - Date.parse(state.lastXrelayCheckAt) < 7 * DAY) return;
  state.lastXrelayCheckAt = new Date().toISOString();
  saveState(STATE_PATH, state);
  const npm = join(dirname(process.execPath), "npm");
  const installed = installedXrelayVersion(env);
  const view = await run(npm, ["view", "x-relay-mcp", "version"], { timeoutMs: MIN, env });
  const latest = view.code === 0 ? view.output.trim().split("\n").at(-1).trim() : null;
  if (!latest) return warn("could not check npm for a newer xrelay — keeping the installed one");
  if (latest === installed) return log(`xrelay ${installed} is current`);
  const res = await step(`update xrelay ${installed ?? "?"} → ${latest}`, () => run(npm, ["i", "-g", `x-relay-mcp@${latest}`], { timeoutMs: 5 * MIN, env }), { fatal: false });
  if (res.code !== 0) return;
  const who = await run("xrelay", ["whoami"], { timeoutMs: 2 * MIN, env });
  if (who.code !== 0 && installed) {
    warn(`xrelay ${latest} failed X auth — rolled back to ${installed}`);
    await run(npm, ["i", "-g", `x-relay-mcp@${installed}`], { timeoutMs: 5 * MIN, env });
  }
}

function proxySecret(env) {
  return env.SEARCH_PROXY_SECRET ?? readRepoEnvLocal().SEARCH_PROXY_SECRET ?? null;
}

/** Confirm the live Worker serves the just-published version (it re-checks the manifest each minute). */
async function verifyPublish(env, version) {
  const secret = proxySecret(env);
  if (!config.workerUrl || !secret) {
    log("publish verification skipped (set workerUrl in config + SEARCH_PROXY_SECRET to enable)");
    return;
  }
  const deadline = Date.now() + 3 * MIN;
  let served = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${config.workerUrl.replace(/\/+$/, "")}/search`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-proxy-secret": secret },
        body: JSON.stringify({ query: "agent", precision: "exact", limit: 3 }),
        signal: AbortSignal.timeout(30_000),
      });
      served = res.headers.get("x-data-version");
      if (res.ok && served === version) return log(`✓ live Worker serves v${version}`);
      if (!res.ok) served = `HTTP ${res.status}`;
    } catch (err) {
      served = err?.cause?.code ?? err.name;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  warn(`live Worker still answers ${served ?? "nothing"} instead of v${version} — is the latest Worker deployed? (npm run deploy:worker)`);
}

// ------------------------------------------------------------------ main

async function main() {
  const { env, cfAuth } = buildEnv();
  const node = process.execPath;
  log(
    `repo ${REPO_ROOT} · node ${process.version} · Cloudflare auth via ${cfAuth} · X cookies via ${env.XRELAY_COOKIES ? "XRELAY_COOKIES" : "browser"}` +
      `${SCHEDULED ? " · scheduled" : ""}${forced ? " · forced" : ""}${DRY_RUN ? " · DRY RUN" : ""}`,
  );

  if (!DRY_RUN) {
    rollDay(state, now);
    state.attemptsToday += 1;
    state.lastAttemptAt = now.toISOString();
    saveState(STATE_PATH, state);
  }

  // --- preflight: fail fast, before anything touches the data
  checkDisk();
  await checkNetwork();
  await maybeUpdateXrelay(env);
  await step("preflight: X auth (xrelay whoami)", () =>
    withRetry("xrelay whoami", 3, 20_000, () => run("xrelay", ["whoami"], { timeoutMs: 2 * MIN, env }), { final: /not logged in/i }),
  );
  const t0 = Date.now();
  log("▶ preflight: Cloudflare token");
  await checkCloudflare(env);
  record.steps.push({ name: "preflight: Cloudflare token", ok: true, ms: Date.now() - t0 });

  record.before = archiveStats();
  log(`archive before: ${record.before.count} bookmarks`);
  if (DRY_RUN) {
    record.ok = true;
    log("dry run — preflight passed, stopping before any data step");
    return;
  }

  ensureEmbedSecret();

  await step("prepare-sync (restore inputs from R2 if missing)", () =>
    run(node, ["scripts/prepare-sync.mjs"], { timeoutMs: 10 * MIN, env }),
  );

  // Truncation guard, part 1: keep the pre-pull archive.
  const beforePull = archiveStats();
  if (existsSync(ARCHIVE)) copyFileSync(ARCHIVE, ARCHIVE_BACKUP);

  // xrelay ≥ 1.7: also capture the author's thread of each NEW bookmark in the same pull
  // (one gentle logged-in lookup per new post with replies; never fails the pull itself).
  const threads = supportsThreads(installedXrelayVersion(env));
  if (!threads) warn("xrelay < 1.7.0 — author threads are not captured (npm i -g x-relay-mcp@latest)");
  const pullArgs = ["archive", "bookmarks", "--out", ARCHIVE, "--limit", "10000", ...(threads ? ["--threads", "--delay", "3000"] : [])];
  await step("xrelay archive bookmarks (incremental pull)", () =>
    withRetry("xrelay archive", 3, 60_000, () => run("xrelay", pullArgs, { timeoutMs: 20 * MIN, env })),
  );

  // Truncation guard, part 2: the archive must never shrink or become unreadable.
  const afterPull = archiveStats();
  if (afterPull.count < beforePull.count) {
    if (existsSync(ARCHIVE_BACKUP)) renameSync(ARCHIVE_BACKUP, ARCHIVE);
    throw new StepError(`archive shrank ${beforePull.count} → ${afterPull.count} after the pull — restored the backup, nothing uploaded`);
  }
  if (existsSync(ARCHIVE_BACKUP)) rmSync(ARCHIVE_BACKUP);
  log(`pulled: ${afterPull.count - beforePull.count} new bookmark(s)`);

  // Author threads of OLDER bookmarks: a gentle chunk per run until the backlog is done
  // (resumable — each checked post is stamped; a rate limit just ends the chunk early).
  const perRun = Number(config.threadBackfillPerRun ?? 300);
  if (threads && perRun > 0) {
    const res = await step(
      `author threads backlog (≤${perRun} lookups)`,
      () => run("xrelay", ["archive", "repair", ARCHIVE, "--threads", "--limit", String(perRun), "--delay", "3000"], { timeoutMs: 35 * MIN, env }),
      { fatal: false }, // best-effort: never blocks today's new bookmarks
    );
    const num = (key) => Number(res?.output?.match(new RegExp(`"${key}":\\s*(\\d+)`))?.[1] ?? NaN);
    if (Number.isFinite(num("checked"))) {
      record.threads = { checked: num("checked"), withThread: num("withThread"), remaining: num("remaining") };
      log(`threads: checked ${record.threads.checked}, ${record.threads.withThread} with a thread, ${record.threads.remaining} left in the backlog`);
    }
  }

  await step("backfill X Article bodies", () => run(node, ["scripts/backfill-articles.mjs"], { timeoutMs: 20 * MIN, env }), {
    fatal: false, // a flaky article is retried next run; don't block today's new bookmarks
  });
  // Resumable (progress flushed atomically), so one in-run retry rides out a transient Workers AI burst.
  await step("sync-bge (embed new posts + rebuild search artifacts)", () =>
    withRetry("sync-bge", 2, 60_000, () => run(node, ["scripts/sync-bge.mjs"], { timeoutMs: 30 * MIN, env })),
  );

  record.after = archiveStats();
  record.added = Math.max(0, record.after.count - record.before.count);

  const fingerprint = dataFingerprint();
  if (shouldUpload(fingerprint, state, FORCE_UPLOAD)) {
    const res = await step("upload-r2 (publish to prod)", () => run(node, ["scripts/upload-r2.mjs"], { timeoutMs: 25 * MIN, env }));
    let summary = {};
    for (const line of res.output.trim().split("\n").reverse()) {
      try {
        summary = JSON.parse(line);
        break;
      } catch {
        /* not the summary line */
      }
    }
    record.uploaded = true;
    record.version = summary.version ?? null;
    state.lastUploaded = { fingerprint, version: summary.version ?? null, at: new Date().toISOString() };
    saveState(STATE_PATH, state);
    if (summary.version) await verifyPublish(env, summary.version);
  } else {
    log("live data already matches the local data — nothing to publish");
  }

  record.ok = true;
  log(`done: +${record.added} (total ${record.after.count})${record.uploaded ? `, published v${record.version}` : ""}`);
}

/** A pull that failed midway must not leave a smaller/corrupt archive behind for the next run. */
function settleArchiveBackup() {
  if (!existsSync(ARCHIVE_BACKUP)) return;
  try {
    const raw = JSON.parse(readFileSync(ARCHIVE_BACKUP, "utf8"));
    const backupCount = (raw.tweets ?? raw.data ?? []).length;
    const current = archiveStats();
    if (current.count < backupCount) {
      renameSync(ARCHIVE_BACKUP, ARCHIVE);
      log(`restored all-bookmarks.json from the pre-pull backup (${current.count} < ${backupCount})`);
    } else {
      rmSync(ARCHIVE_BACKUP);
    }
  } catch (err) {
    log(`could not settle the archive backup: ${err.message}`);
  }
}

// Keep the Mac from idle-sleeping mid-run (setTimeout-based timeouts pause during sleep). caffeinate
// exits by itself when this process does.
const caffeinate = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true });
caffeinate.on("error", () => {});
caffeinate.unref();

let exitCode = 0;
let failure = null;
const priorFailures = state.consecutiveFailures;
try {
  await main();
} catch (err) {
  exitCode = 1;
  record.error = err instanceof Error ? err.message : String(err);
  failure = classifyError(record.error, err?.output ?? "");
  record.code = failure.code;
  log(`✖ [${failure.code}] ${record.error}`);
  log(`  fix: ${failure.hint}`);
  settleArchiveBackup();
} finally {
  if (!DRY_RUN) {
    if (record.ok) {
      state.lastSuccessAt = new Date().toISOString();
      state.consecutiveFailures = 0;
      state.lastFailure = null;
      state.lastAttemptCode = null;
      state.staleNotifiedAt = null;
    } else if (failure) {
      state.consecutiveFailures += 1;
      state.lastAttemptCode = failure.code;
      state.lastFailure = { ...failure, message: record.error.slice(0, 500), at: new Date().toISOString() };
      if (failure.code === "OFFLINE") state.attemptsToday = Math.max(0, state.attemptsToday - 1); // don't burn attempts while offline
    }
    saveState(STATE_PATH, state);
    appendRun(RUNS_PATH, {
      startedAt: record.startedAt,
      ms: Date.now() - now.getTime(),
      ok: record.ok,
      code: record.code,
      error: record.error?.slice(0, 300) ?? null,
      added: record.added,
      uploaded: record.uploaded,
      version: record.version,
      forced,
    });
  }
  record.finishedAt = new Date().toISOString();
  writeFileSync(LAST_RUN_PATH, `${JSON.stringify(record, null, 2)}\n`);
  releaseLock(LOCK_PATH);
  try {
    pruneLogs();
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ tell the user (only when useful)

if (failure && !DRY_RUN) {
  const day = localDay(new Date());
  const lastAttempt = state.attemptsToday >= config.maxAttemptsPerDay;
  const key = `${failure.code}:${day}`;
  // Scheduled: retryable causes stay quiet until the day's last attempt; offline never notifies
  // (the stale alert covers a long outage). Manual runs always report.
  const tell = !SCHEDULED || forced || (failure.code !== "OFFLINE" && (!failure.retryable || lastAttempt));
  if (tell && !state.notified[key]) {
    state.notified = Object.fromEntries(Object.entries(state.notified).filter(([k]) => k.endsWith(day)));
    state.notified[key] = true;
    saveState(STATE_PATH, state);
    notify("failure", `X Bookmarks sync: ${failure.title}`, failure.hint, failure.retryable && !lastAttempt ? "Will retry automatically" : "");
  } else if (failure.retryable && SCHEDULED) {
    log(`retryable — next attempt: ${nextAttemptLabel()}`);
  }
  staleCheck();
} else if (failure && DRY_RUN) {
  notify("failure", `X Bookmarks sync check: ${failure.title}`, failure.hint);
} else if (record.ok && !DRY_RUN) {
  const recovered = priorFailures > 0;
  if (record.added > 0 || config.notify === "always" || recovered) {
    const total = record.after?.count?.toLocaleString("en") ?? "?";
    notify(
      "success",
      record.added > 0 ? `+${record.added} new bookmark${record.added === 1 ? "" : "s"}` : recovered ? "Bookmark sync is back to normal" : "Bookmarks up to date",
      `${total} bookmarks${record.uploaded ? " · live on the site" : ""}`,
      recovered && record.added > 0 ? "Recovered after a failure" : "",
    );
  }
}

refreshStatusPage(logPath);
logFile.end();
// Exit explicitly so a lingering child handle can never keep launchd's job "running".
logFile.on("finish", () => process.exit(exitCode));
setTimeout(() => process.exit(exitCode), 2000).unref();
