// Shared config/paths for the bookmark-sync autopilot (scripts/auto-sync.mjs + scripts/autosync.mjs).
// Everything machine-specific lives OUTSIDE the repo:
//   ~/.config/xbookmarks-sync/config.json   schedule + behavior (written by `npm run autosync -- install`)
//   ~/.local/state/xbookmarks-sync/          run history (runs.jsonl), last-run.json, status.html, and
//                                            logs/ (per-run logs, launchd stdout/stderr). NOT ~/Library/Logs:
//                                            Mac cleaners (CleanMyMac Smart Scan, `mo clean`) empty that
//                                            folder, which took the history and the status page with it.
//   ~/.config/xbookmarks-sync/env            optional secrets file (chmod 600): KEY=VALUE lines loaded into
//                                            every run — CLOUDFLARE_API_TOKEN, XRELAY_COOKIES, … Best for a
//                                            headless box (Mac mini): no keychain unlock, no 1Password prompt.
//   Cloudflare API token, from the FIRST source that yields one:
//     1. CLOUDFLARE_API_TOKEN in the environment — real env, or the env file above
//     2. 1Password: `op read <cloudflareTokenRef>` — unattended via a service-account token kept in the
//        Keychain (OP_SERVICE_ACCOUNT_TOKEN), otherwise via the 1Password app (Touch ID prompt)
//     3. macOS Keychain, service "xbookmarks-sync", account CLOUDFLARE_API_TOKEN
//     4. none → wrangler's own `wrangler login` session (expires; fine for manual runs only)
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LABEL = "com.xbookmarks.sync";
export const CONFIG_DIR = join(homedir(), ".config", "xbookmarks-sync");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const STATE_DIR = join(homedir(), ".local", "state", "xbookmarks-sync");
export const LOG_DIR = join(STATE_DIR, "logs");
export const LAST_RUN_PATH = join(STATE_DIR, "last-run.json");
export const LOCK_PATH = join(CONFIG_DIR, "sync.lock");
export const STATE_PATH = join(CONFIG_DIR, "state.json"); // scheduling + last-published state (lib/sync-state.mjs)
export const RUN_NOW_MARKER = join(CONFIG_DIR, "run-now"); // one-shot "ignore the schedule" (autosync -- run)
export const RUNS_PATH = join(STATE_DIR, "runs.jsonl"); // run history for status + the status page
export const ENV_FILE_PATH = join(CONFIG_DIR, "env");
export const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
export const KEYCHAIN_SERVICE = "xbookmarks-sync";
export const KEYCHAIN_TOKEN_ACCOUNT = "CLOUDFLARE_API_TOKEN";
export const KEYCHAIN_OP_SA_ACCOUNT = "OP_SERVICE_ACCOUNT_TOKEN";

export const DEFAULT_CONFIG = {
  slots: ["11:00", "14:00"], // local times a sync is due; launchd also ticks hourly, so a missed slot (asleep/off) is caught up later
  maxAttemptsPerDay: 6, // failed runs are retried the same day (successful slot runs count too)…
  retryHours: 2, // …this many hours apart (offline: every tick, without using up attempts)
  staleDays: 3, // notify when there has been no successful sync for this long
  notify: "changes", // "always" | "changes" (new bookmarks or failure) | "failure" | "never"
  updateXrelay: true, // weekly: install a newer x-relay-mcp only if npm has one; rolled back if X auth breaks
  threadBackfillPerRun: 300, // author threads of older bookmarks looked up per run (logged-in X calls, ~4s each); 0 = off
  workerUrl: null, // deployed search Worker, e.g. https://bookmark-search.<sub>.workers.dev — enables publish verification
  siteUrl: null, // the app, linked from the status page
  cloudflareAccountId: null, // set if your API token can see more than one account (wrangler would prompt)
  cloudflareTokenRef: null, // 1Password secret reference, e.g. "op://Automation/Cloudflare xbookmarks/credential"
  xrelayBrowser: null, // XRELAY_BROWSER passthrough, e.g. "chrome" — which browser xrelay reads X cookies from
  keepLogs: 30,
};

export function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`invalid ${CONFIG_PATH}: ${err.message}`);
  }
  // Pre-slots config: one daily { hour, minute } slot — keep that time until `install --slots` changes it.
  if (!Array.isArray(raw.slots) && Number.isInteger(raw.hour)) {
    raw.slots = [`${String(raw.hour).padStart(2, "0")}:${String(raw.minute ?? 0).padStart(2, "0")}`];
  }
  delete raw.hour;
  delete raw.minute;
  return { ...DEFAULT_CONFIG, ...raw };
}

export function saveConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

/** KEY=VALUE pairs from the repo's .env.local (the app's own secrets, e.g. SEARCH_PROXY_SECRET). */
export function readRepoEnvLocal() {
  const path = join(REPO_ROOT, ".env.local");
  if (!existsSync(path)) return {};
  const vars = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#")) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}

/** Parse the env file into { vars, warning }. Missing file → no vars. Group/world-readable → warning. */
export function readEnvFile() {
  if (!existsSync(ENV_FILE_PATH)) return { vars: {}, warning: null };
  const vars = {};
  for (const line of readFileSync(ENV_FILE_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const raw = m[2];
    if (/^".*"$/.test(raw)) vars[m[1]] = raw.slice(1, -1).replace(/\\(.)/g, "$1"); // dotenv-style escapes
    else if (/^'.*'$/.test(raw)) vars[m[1]] = raw.slice(1, -1);
    else vars[m[1]] = raw;
  }
  const mode = statSync(ENV_FILE_PATH).mode & 0o777;
  const warning = mode & 0o077 ? `${ENV_FILE_PATH} is readable by other users (mode ${mode.toString(8)}) — run: chmod 600 "${ENV_FILE_PATH}"` : null;
  return { vars, warning };
}

/** Set (or replace) KEY=VALUE in the env file, keeping other lines; the file is always left mode 600. */
export function writeEnvFileVar(key, value) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const lines = existsSync(ENV_FILE_PATH) ? readFileSync(ENV_FILE_PATH, "utf8").split(/\r?\n/).filter((l, i, a) => l || i < a.length - 1) : [
    "# X Bookmarks sync secrets — loaded into every autopilot run. Keep this file chmod 600.",
  ];
  const quoted = /[\s#;"'$]/.test(value) ? `"${value.replace(/(["\\$`])/g, "\\$1")}"` : value;
  const i = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}\\s*=`).test(l));
  if (i >= 0) lines[i] = `${key}=${quoted}`;
  else lines.push(`${key}=${quoted}`);
  writeFileSync(ENV_FILE_PATH, `${lines.join("\n")}\n`, { mode: 0o600 });
  chmodSync(ENV_FILE_PATH, 0o600);
}

/** A secret from the login Keychain, or null. The `security` CLI created the item, so it reads it back without a prompt. */
export function readKeychainSecret(account) {
  const res = spawnSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
    encoding: "utf8",
  });
  const value = res.status === 0 ? res.stdout.trim() : "";
  return value || null;
}

export function readKeychainToken() {
  return readKeychainSecret(KEYCHAIN_TOKEN_ACCOUNT);
}

const OP_CANDIDATES = ["/opt/homebrew/bin/op", "/usr/local/bin/op"];

/**
 * `op read <ref>`. With a service-account token in the Keychain it runs fully unattended; without one
 * it goes through the 1Password app (desktop integration → Touch ID). Returns { value } or { error }.
 */
export function readOnePassword(ref) {
  const op = OP_CANDIDATES.find((p) => existsSync(p)) ?? "op";
  const env = { ...process.env };
  const serviceAccount = readKeychainSecret(KEYCHAIN_OP_SA_ACCOUNT);
  if (serviceAccount && !env.OP_SERVICE_ACCOUNT_TOKEN) env.OP_SERVICE_ACCOUNT_TOKEN = serviceAccount;
  const res = spawnSync(op, ["read", "--no-newline", ref], { encoding: "utf8", env, timeout: 90_000 });
  if (res.status === 0 && res.stdout.trim()) return { value: res.stdout.trim(), via: serviceAccount ? "1Password service account" : "1Password app" };
  return { error: (res.stderr || res.error?.message || `op exited ${res.status}`).trim().split("\n").at(-1) };
}

/** Resolve the Cloudflare API token (see the source order at the top of this file). */
export function resolveCloudflareToken(config, env = process.env, envFileKeys = new Set()) {
  if (env.CLOUDFLARE_API_TOKEN) {
    return { token: env.CLOUDFLARE_API_TOKEN, source: envFileKeys.has("CLOUDFLARE_API_TOKEN") ? "env file" : "CLOUDFLARE_API_TOKEN env" };
  }
  const warnings = [];
  if (config.cloudflareTokenRef) {
    const res = readOnePassword(config.cloudflareTokenRef);
    if (res.value) return { token: res.value, source: res.via, warnings };
    warnings.push(`1Password read failed (${res.error}) — falling back`);
  }
  const keychain = readKeychainToken();
  if (keychain) return { token: keychain, source: "Keychain API token", warnings };
  return { token: null, source: "wrangler login", warnings };
}
