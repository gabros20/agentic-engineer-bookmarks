#!/usr/bin/env node
// Control the bookmark-sync autopilot: a per-user launchd agent that ticks scripts/auto-sync.mjs every
// hour, at each sync slot and at login (--scheduled); each tick decides whether a sync is due (daily
// slots — default 11:00 + 14:00 —, same-day retries, missed-slot catch-up — scripts/lib/sync-state.mjs).
// LaunchAgents load at login, so the schedule survives restarts; missed ticks while asleep coalesce
// into one on wake. macOS lists the agent under Login Items → "Allow in the Background" as "node":
// switched off there, it never loads (doctor + install say so).
//
//   npm run autosync -- setup            guided, idempotent first-time setup (+ re-run any time to repair)
//   npm run autosync -- doctor           read-only health check: ✓/⚠/✖ per dependency, with the fix
//   npm run autosync -- status           schedule, last success, next attempt, auth, last run
//   npm run autosync -- run              sync NOW under launchd (ignores the schedule once)
//   npm run autosync -- open             open the status page (also what clicking a notification does)
//   npm run autosync -- notify-test      post a test notification (and trigger the macOS permission prompt)
//   npm run autosync -- logs             print the latest run log
//   npm run autosync -- install [--slots 11:00,14:00] [--max-attempts 6] [--notify changes|always|failure|never]
//                               [--browser chrome] [--account-id <cf-account>] [--worker-url <url>] [--site-url <url>]
//   npm run autosync -- set-token        store the Cloudflare API token in the login Keychain, OR
//                       set-token --env-file                       ~/.config/xbookmarks-sync/env (chmod 600; headless box)
//                       set-token --1password "op://Vault/Item/credential"   read it from 1Password
//                       set-token --op-service-account             unattended 1Password reads (no Touch ID)
//   npm run autosync -- set-cookies      XRELAY_COOKIES (X auth_token + ct0) in the env file, for a box
//                                        without a logged-in browser
//   npm run autosync -- uninstall        unload + remove the agent (config/logs kept)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CONFIG_PATH,
  STATE_DIR,
  ENV_FILE_PATH,
  KEYCHAIN_OP_SA_ACCOUNT,
  KEYCHAIN_SERVICE,
  KEYCHAIN_TOKEN_ACCOUNT,
  LABEL,
  LAST_RUN_PATH,
  LOG_DIR,
  PLIST_PATH,
  REPO_ROOT,
  RUN_NOW_MARKER,
  STATE_PATH,
  loadConfig,
  readEnvFile,
  readKeychainSecret,
  readKeychainToken,
  readOnePassword,
  readRepoEnvLocal,
  resolveCloudflareToken,
  saveConfig,
  writeEnvFileVar,
} from "./lib/autosync-config.mjs";
import { probeRest, resolveAccountId } from "./lib/embed-transport.mjs";
import { APP_PATH, STATUS_PAGE, buildNotifierApp, notifierInstalled, notify } from "./lib/notifier.mjs";
import { attemptsToday, describeSlots, formatSlot, formatWhen, loadState, nextRunAt, parseSlots, tickMinutes } from "./lib/sync-state.mjs";

const [command = "status", ...rest] = process.argv.slice(2);
const uid = process.getuid();
const domain = `gui/${uid}`;
const service = `${domain}/${LABEL}`;
const CF_API = "https://api.cloudflare.com/client/v4";
const BUCKET = "bookmark-search-data";

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
}

function launchctl(...args) {
  return spawnSync("/bin/launchctl", args, { encoding: "utf8" });
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plist({ node, config }) {
  // Real path of the node binary: version managers (fnm/nvm) hand shells a per-session symlink that
  // disappears; launchd needs the stable install path. Its bin dir also holds npm + global xrelay.
  const path = [dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  // A tick every hour + at each slot (cheap no-op unless a sync is due) + RunAtLoad for a catch-up at login.
  const ticks = tickMinutes(config)
    .map((m) => `    <dict><key>Hour</key><integer>${Math.floor(m / 60)}</integer><key>Minute</key><integer>${m % 60}</integer></dict>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(join(REPO_ROOT, "scripts", "auto-sync.mjs"))}</string>
    <string>--scheduled</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(REPO_ROOT)}</string>
  <key>StartCalendarInterval</key>
  <array>
${ticks}
  </array>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(path)}</string>
    <key>HOME</key><string>${xmlEscape(process.env.HOME)}</string>
  </dict>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xmlEscape(join(LOG_DIR, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(LOG_DIR, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

/** Opens System Settings at Login Items & Extensions (only shows the pane; changes nothing). */
const LOGIN_ITEMS_PANE = "x-apple.systempreferences:com.apple.LoginItems-Settings.extension";
const BLOCKED_HINT =
  'macOS is blocking it: System Settings → General → Login Items & Extensions → "Allow in the Background" → turn on "node" (that is this sync), then run: npm run autosync -- install';

function install() {
  const config = loadConfig();
  const slots = flag("slots") !== undefined ? flag("slots").split(",").map((s) => s.trim()).filter(Boolean) : config.slots;
  parseSlots(slots); // throws on a malformed slot
  const maxAttempts = flag("max-attempts") !== undefined ? Number(flag("max-attempts")) : config.maxAttemptsPerDay;
  if (!Number.isInteger(maxAttempts) || maxAttempts < slots.length) throw new Error(`--max-attempts must be a whole number ≥ the number of slots (${slots.length})`);
  const notifyMode = flag("notify") ?? config.notify;
  if (!["always", "changes", "failure", "never"].includes(notifyMode)) throw new Error("--notify: always|changes|failure|never");
  const next = {
    ...config,
    slots: parseSlots(slots).map(formatSlot),
    maxAttemptsPerDay: maxAttempts,
    notify: notifyMode,
    xrelayBrowser: flag("browser") ?? config.xrelayBrowser,
    cloudflareAccountId: flag("account-id") ?? config.cloudflareAccountId,
    workerUrl: flag("worker-url") ?? config.workerUrl,
    siteUrl: flag("site-url") ?? config.siteUrl,
  };
  saveConfig(next);

  const built = buildNotifierApp();
  console.log(built.ok ? `✓ notifier app  ${APP_PATH}` : `! notifier app could not be built (${built.error}) — falling back to plain notifications`);

  const node = realpathSync(process.execPath);
  mkdirSync(LOG_DIR, { recursive: true }); // launchd writes its stdout/stderr here and won't create the folder
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, plist({ node, config: next }));

  launchctl("bootout", service); // ignore "not loaded"
  const res = launchctl("bootstrap", domain, PLIST_PATH);
  if (res.status !== 0 || launchctl("print", service).status !== 0) {
    spawnSync("/usr/bin/open", [LOGIN_ITEMS_PANE]);
    throw new Error(`the agent did not load (${(res.stderr || res.stdout).trim() || "not running after bootstrap"}).\n  ${BLOCKED_HINT}`);
  }

  console.log(`✓ installed ${LABEL}: syncs daily at ${describeSlots(next)} (hourly checks, same-day retries, catch-up at login)`);
  console.log(`  node   ${node}`);
  console.log(`  plist  ${PLIST_PATH}`);
  console.log(`  config ${CONFIG_PATH}`);
  if (!readKeychainToken() && !next.cloudflareTokenRef && !readEnvFile().vars.CLOUDFLARE_API_TOKEN) {
    console.log("\n! No Cloudflare API token configured yet. Run:  npm run autosync -- set-token");
  }
}

function uninstall() {
  launchctl("bootout", service);
  if (existsSync(PLIST_PATH)) rmSync(PLIST_PATH);
  console.log(`✓ removed ${LABEL} (config ${CONFIG_PATH}, history + logs ${STATE_DIR} and ${APP_PATH} kept)`);
}

const TOKEN_HELP =
  "Cloudflare API token (dash.cloudflare.com → My Profile → API Tokens → Create), scoped to your account:\n" +
  "  Account · Workers R2 Storage: Edit   (publish/restore the bookmark-search-data bucket)\n" +
  "  Account · Workers AI: Read           (embed new posts with bge-m3 over the REST API)\n" +
  "  Account · Account Settings: Read     (account lookup)\n" +
  "  Optional: Account · Workers Scripts: Edit (only for the local `wrangler dev` embed fallback)\n";

/** Store a secret in the login Keychain; `-w` LAST makes `security` prompt for it (hidden, never in argv/history). */
function storeKeychainSecret(account, label) {
  const res = spawnSync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-l", label, "-w"],
    { stdio: "inherit" },
  );
  if (res.status !== 0) throw new Error("could not store the secret in the Keychain");
}

/** Token status + account via the Cloudflare API (≈1s; `wrangler whoami` took 20+s). */
async function cloudflareCheck(token, preset) {
  if (!token) return { ok: false, error: "no token" };
  const auth = { authorization: `Bearer ${token}` };
  try {
    let res = await fetch(`${CF_API}/user/tokens/verify`, { headers: auth, signal: AbortSignal.timeout(20_000) });
    if (!res.ok && preset) res = await fetch(`${CF_API}/accounts/${preset}/tokens/verify`, { headers: auth, signal: AbortSignal.timeout(20_000) });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.result?.status !== "active") return { ok: false, error: `token ${body?.result?.status ?? `rejected (HTTP ${res.status})`}` };
    const account = await resolveAccountId(token, preset);
    if (account.error) return { ok: false, error: account.error };
    return { ok: true, accountId: account.accountId };
  } catch (err) {
    return { ok: false, error: `could not reach Cloudflare (${err?.cause?.code ?? err.message})` };
  }
}

async function verifyCloudflareToken(token) {
  const check = await cloudflareCheck(token, loadConfig().cloudflareAccountId);
  if (!check.ok) {
    console.log(`! Cloudflare: ${check.error}`);
    process.exitCode = 1;
    return;
  }
  saveConfig({ ...loadConfig(), cloudflareAccountId: check.accountId });
  console.log(`✓ Cloudflare accepted the token (account ${check.accountId})`);
  const probe = await probeRest({ accountId: check.accountId, token });
  console.log(probe.ok ? "✓ Workers AI reachable (embeddings run over the REST API — no local server)" : `! Workers AI: ${probe.error}\n  The sync falls back to a local wrangler dev; add "Workers AI: Read" to the token to avoid it.`);
}

/** Read one line from the terminal (hidden for secrets; never in argv or shell history). */
function prompt(label, { hidden = true, optional = false } = {}) {
  const res = spawnSync("/bin/bash", ["-c", `read -r ${hidden ? "-s " : ""}-p "${label}: " V; ${hidden ? "echo >&2; " : ""}printf %s "$V"`], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  const value = (res.stdout ?? "").trim();
  if (!value && !optional) throw new Error("nothing entered");
  return value;
}

function xrelayBin() {
  return join(dirname(realpathSync(process.execPath)), "xrelay");
}

function setCookies() {
  console.log(
    "X session cookies for xrelay (lets a headless box pull bookmarks without a logged-in browser).\n" +
      "In a browser logged into x.com: DevTools → Application → Cookies → https://x.com → copy `auth_token` and `ct0`.\n" +
      "They last until you log out of that X session; re-run this if `xrelay whoami` starts failing.\n",
  );
  const authToken = prompt("auth_token");
  const ct0 = prompt("ct0");
  writeEnvFileVar("XRELAY_COOKIES", `auth_token=${authToken}; ct0=${ct0}`);
  const who = spawnSync(xrelayBin(), ["whoami"], { encoding: "utf8", env: { ...process.env, XRELAY_COOKIES: `auth_token=${authToken}; ct0=${ct0}` } });
  console.log(who.status === 0 ? `✓ saved to ${ENV_FILE_PATH} and X accepted the cookies` : `! saved, but xrelay whoami failed:\n${`${who.stdout}${who.stderr}`.trim().slice(-400)}`);
  if (who.status !== 0) process.exitCode = 1;
}

async function setToken() {
  if (rest.includes("--env-file")) {
    console.log(`${TOKEN_HELP}\nIt is written to ${ENV_FILE_PATH} (mode 600, outside the repo).\n`);
    const token = prompt("Cloudflare API token");
    writeEnvFileVar("CLOUDFLARE_API_TOKEN", token);
    console.log(`✓ saved to ${ENV_FILE_PATH}`);
    return verifyCloudflareToken(token);
  }
  const ref = flag("1password");
  if (rest.includes("--op-service-account")) {
    console.log(
      "1Password service account token (1Password → Developer → Service Accounts → create one with READ access to\n" +
        "the vault that holds the Cloudflare token ONLY). Paste it at the prompt (hidden); it goes to the Keychain.\n",
    );
    storeKeychainSecret(KEYCHAIN_OP_SA_ACCOUNT, "X Bookmarks sync (1Password service account)");
    console.log("✓ stored — `op read` will now run unattended");
    const configured = loadConfig().cloudflareTokenRef;
    if (!configured) return console.log('Next: npm run autosync -- set-token --1password "op://Vault/Item/credential"');
    const res = readOnePassword(configured);
    if (!res.value) throw new Error(`service account can't read ${configured}: ${res.error}`);
    console.log(`✓ read ${configured} via ${res.via}`);
    return verifyCloudflareToken(res.value);
  }
  if (ref !== undefined) {
    if (!/^op:\/\/[^/]+\/[^/]+\/.+/.test(ref)) throw new Error('expected a secret reference like "op://Vault/Item/credential"');
    console.log(TOKEN_HELP);
    const res = readOnePassword(ref);
    if (!res.value) throw new Error(`op read failed: ${res.error} — is the 1Password app unlocked / the reference right?`);
    console.log(`✓ read ${ref} via ${res.via}`);
    await verifyCloudflareToken(res.value);
    saveConfig({ ...loadConfig(), cloudflareTokenRef: ref });
    console.log(`✓ saved the reference to ${CONFIG_PATH} (the token itself is never written to disk)`);
    if (!readKeychainSecret(KEYCHAIN_OP_SA_ACCOUNT)) {
      console.log(
        "\nNote: without a 1Password service account, each run asks the 1Password app (Touch ID) and\n" +
          "fails if it's locked. For fully unattended runs: npm run autosync -- set-token --op-service-account",
      );
    }
    return;
  }
  console.log(`${TOKEN_HELP}\nPaste it at the prompt (hidden). It is stored in your login Keychain, never on disk.\n`);
  storeKeychainSecret(KEYCHAIN_TOKEN_ACCOUNT, "X Bookmarks sync (Cloudflare API token)");
  return verifyCloudflareToken(readKeychainToken());
}

function ago(iso) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function status() {
  const config = loadConfig();
  const state = loadState(STATE_PATH);
  const installed = existsSync(PLIST_PATH);
  console.log(`Autopilot    ${installed ? "installed" : "NOT installed — run: npm run autosync -- setup"} (${LABEL})`);
  console.log(`Schedule     daily at ${describeSlots(config)} · retries every ${config.retryHours} h (max ${config.maxAttemptsPerDay}/day) · notify: ${config.notify}`);
  if (installed) {
    const printed = launchctl("print", service);
    if (printed.status === 0) {
      const pick = (key) => printed.stdout.match(new RegExp(`\\n\\s*${key} = ([^\\n]+)`))?.[1]?.trim();
      console.log(`Agent        loaded · state ${pick("state") ?? "?"} · last exit ${pick("last exit code") ?? "n/a"}`);
    } else {
      console.log(`Agent        plist present but NOT loaded — ${BLOCKED_HINT}`);
    }
    const plistText = readFileSync(PLIST_PATH, "utf8");
    const node = plistText.match(/<array>\s*<string>([^<]+)<\/string>/)?.[1];
    if (node && !existsSync(node)) console.log(`! node binary is gone (${node}) — reinstall after a Node upgrade: npm run autosync -- install`);
    if (!plistText.includes("--scheduled")) console.log("! old single-daily schedule — upgrade: npm run autosync -- install");
  }
  console.log(`Last success ${ago(state.lastSuccessAt)}${state.consecutiveFailures ? ` · ${state.consecutiveFailures} failed attempt(s) since` : ""}`);
  console.log(`Next attempt ${formatWhen(nextRunAt(state, config))} · attempts today ${attemptsToday(state)}/${config.maxAttemptsPerDay}`);
  if (state.lastFailure) console.log(`Last failure [${state.lastFailure.code}] ${state.lastFailure.title} — ${state.lastFailure.hint}`);
  if (state.lastUploaded) console.log(`Live data    v${state.lastUploaded.version ?? "?"} · published ${ago(state.lastUploaded.at)}`);
  // Describe the token source without reading it (an op read could trigger a Touch ID prompt).
  const sources = [];
  const { vars: envVars, warning: envWarning } = readEnvFile();
  if (process.env.CLOUDFLARE_API_TOKEN) sources.push("CLOUDFLARE_API_TOKEN env ✓");
  if (envVars.CLOUDFLARE_API_TOKEN) sources.push(`env file ✓ (${ENV_FILE_PATH})`);
  if (config.cloudflareTokenRef) {
    sources.push(`1Password ${config.cloudflareTokenRef} (${readKeychainSecret(KEYCHAIN_OP_SA_ACCOUNT) ? "service account ✓, unattended" : "via the app — Touch ID each run"})`);
  }
  if (readKeychainToken()) sources.push("Keychain API token ✓");
  console.log(`Cloudflare   ${sources.length ? sources.join(" → then ") : "no token — run: npm run autosync -- set-token"}`);
  console.log(`X auth       ${envVars.XRELAY_COOKIES || process.env.XRELAY_COOKIES ? "XRELAY_COOKIES (env file/env) ✓" : `browser cookies${config.xrelayBrowser ? ` (${config.xrelayBrowser})` : ""} — needs a logged-in browser on this Mac`}`);
  console.log(`Notifier     ${notifierInstalled() ? `✓ ${APP_PATH}` : "not built — run: npm run autosync -- install"}`);
  if (envWarning) console.log(`! ${envWarning}`);
  if (existsSync(LAST_RUN_PATH)) {
    const last = JSON.parse(readFileSync(LAST_RUN_PATH, "utf8"));
    const verdict = last.ok ? "✓ ok" : `✖ ${last.error}`;
    const detail = last.after ? ` · +${last.added} → ${last.after.count} bookmarks${last.uploaded ? " · published" : ""}` : "";
    console.log(`Last run     ${last.finishedAt} ${last.dryRun ? "(dry run) " : ""}${verdict}${detail}`);
    for (const w of last.warnings ?? []) console.log(`             ⚠ ${w}`);
    console.log(`Log          ${last.log}`);
  }
  console.log(`Details      npm run autosync -- open   ·   health check: npm run autosync -- doctor`);
}

function runNow() {
  if (!existsSync(PLIST_PATH)) throw new Error("not installed — run: npm run autosync -- setup");
  writeFileSync(RUN_NOW_MARKER, new Date().toISOString()); // the scheduled run honors this once
  const res = launchctl("kickstart", service);
  if (res.status !== 0) throw new Error(`kickstart failed: ${(res.stderr || res.stdout).trim()}`);
  console.log(`▶ started ${LABEL} under launchd. Follow along: tail -f "${join(LOG_DIR, "launchd.out.log")}"  ·  then: npm run autosync -- status`);
}

function logs() {
  const files = existsSync(LOG_DIR) ? readdirSync(LOG_DIR).filter((f) => /^sync-.*\.log$/.test(f)).sort() : [];
  if (!files.length) return console.log("no runs yet");
  process.stdout.write(readFileSync(join(LOG_DIR, files.at(-1)), "utf8"));
}

function openStatus() {
  if (!existsSync(STATUS_PAGE)) return console.log("No status page yet — it is written after the first run (npm run autosync -- run).");
  spawnSync("/usr/bin/open", [STATUS_PAGE]);
}

function notifyTest() {
  if (!notifierInstalled()) {
    const built = buildNotifierApp();
    if (!built.ok) console.log(`! notifier app could not be built (${built.error}) — using a plain notification`);
  }
  notify({ title: "X Bookmarks Sync", subtitle: "Notifications are working", message: "Click to open the sync status page." });
  console.log("✓ sent. Don't see it? System Settings → Notifications → X Bookmarks Sync → Allow (first run asks).");
}

// ------------------------------------------------------------------ doctor + setup

async function runChecks() {
  const config = loadConfig();
  const state = loadState(STATE_PATH);
  const results = [];
  const add = (level, name, detail, fix) => results.push({ level, name, detail, fix });

  // Schedule
  if (!existsSync(PLIST_PATH)) add("error", "Schedule", "launchd agent not installed", "npm run autosync -- setup");
  else {
    const loaded = launchctl("print", service).status === 0;
    const text = readFileSync(PLIST_PATH, "utf8");
    const node = text.match(/<array>\s*<string>([^<]+)<\/string>/)?.[1];
    if (!loaded) add("error", "Schedule", "agent installed but not loaded — macOS doesn't run it", BLOCKED_HINT);
    else if (node && !existsSync(node)) add("error", "Schedule", `node binary gone (${node})`, "npm run autosync -- install");
    else if (!text.includes("--scheduled")) add("warn", "Schedule", "old once-a-day schedule (no retries/catch-up)", "npm run autosync -- install");
    else if (!slotMinutesInPlist(text, config)) add("warn", "Schedule", `the agent's wake-up times predate the ${describeSlots(config)} slots`, "npm run autosync -- install");
    else add("ok", "Schedule", `daily at ${describeSlots(config)}, hourly checks for retries/catch-up`);
  }

  // xrelay + X auth
  const xrelay = spawnSync(xrelayBin(), ["whoami"], { encoding: "utf8", env: { ...process.env, ...readEnvFile().vars }, timeout: 120_000 });
  if (xrelay.error?.code === "ENOENT") add("error", "X (xrelay)", "xrelay is not installed", "npm i -g x-relay-mcp");
  else if (xrelay.status !== 0) add("error", "X (xrelay)", "not logged in to X", "log into x.com in your browser, or: npm run autosync -- set-cookies");
  else {
    const handle = xrelay.stdout.match(/"handle":\s*"([^"]+)"/)?.[1];
    add("ok", "X (xrelay)", `logged in${handle ? ` as @${handle}` : ""}`);
  }

  // Cloudflare
  const { vars } = readEnvFile();
  const env = { ...vars, ...process.env };
  const { token, source } = resolveCloudflareToken(config, env, new Set(Object.keys(vars)));
  const cf = await cloudflareCheck(token, config.cloudflareAccountId);
  if (!token) add("error", "Cloudflare token", "none configured", "npm run autosync -- set-token");
  else if (!cf.ok) add("error", "Cloudflare token", `${cf.error} (from ${source})`, "npm run autosync -- set-token");
  else {
    add("ok", "Cloudflare token", `active (from ${source}) · account ${cf.accountId}`);
    if (config.cloudflareAccountId !== cf.accountId) saveConfig({ ...loadConfig(), cloudflareAccountId: cf.accountId });
    const probe = await probeRest({ accountId: cf.accountId, token });
    if (probe.ok) add("ok", "Workers AI", "embeddings over the REST API (no local server)");
    else add("warn", "Workers AI", `${probe.error} — will fall back to a local wrangler dev`, 'add "Workers AI: Read" to the token');
    try {
      const res = await fetch(`${CF_API}/accounts/${cf.accountId}/r2/buckets/${BUCKET}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) add("ok", "R2 bucket", BUCKET);
      else add("error", "R2 bucket", `HTTP ${res.status} for ${BUCKET}`, 'the token needs "Workers R2 Storage: Edit"');
    } catch (err) {
      add("warn", "R2 bucket", `could not check (${err?.cause?.code ?? err.message})`);
    }
  }

  // Live Worker
  const secret = env.SEARCH_PROXY_SECRET ?? readRepoEnvLocal().SEARCH_PROXY_SECRET;
  if (!config.workerUrl) add("warn", "Live Worker", "workerUrl not set — publishes aren't verified", "npm run autosync -- install --worker-url https://bookmark-search.<sub>.workers.dev");
  else if (!secret) add("warn", "Live Worker", "no SEARCH_PROXY_SECRET (env file or .env.local) — publishes aren't verified");
  else {
    try {
      const res = await fetch(`${config.workerUrl.replace(/\/+$/, "")}/search`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-proxy-secret": secret },
        body: JSON.stringify({ query: "agent", precision: "exact", limit: 3 }),
        signal: AbortSignal.timeout(30_000),
      });
      const version = res.headers.get("x-data-version");
      if (!res.ok) add("error", "Live Worker", `/search answered HTTP ${res.status}`, "npm run deploy:worker");
      else if (!version) add("warn", "Live Worker", "search works, but the Worker predates versioned data", "npm run deploy:worker");
      else add("ok", "Live Worker", `search works · serving data v${version}`);
    } catch (err) {
      add("error", "Live Worker", `unreachable (${err?.cause?.code ?? err.message})`);
    }
  }

  // Local machine
  const fs = statfsSync(REPO_ROOT);
  const freeGb = (fs.bavail * fs.bsize) / 1e9;
  add(freeGb >= 1 ? "ok" : "error", "Disk", `${freeGb.toFixed(1)} GB free`, freeGb >= 1 ? undefined : "free at least 1 GB");
  add(notifierInstalled() ? "ok" : "warn", "Notifications", notifierInstalled() ? APP_PATH : "branded notifier not built", notifierInstalled() ? undefined : "npm run autosync -- install");

  // History
  const last = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : null;
  if (!last) add("warn", "Last sync", "no successful sync recorded yet", "npm run autosync -- run");
  else {
    const days = (Date.now() - last) / 86_400_000;
    const detail = `${ago(state.lastSuccessAt)}${state.lastFailure ? ` · last failure: ${state.lastFailure.title}` : ""}`;
    add(days < config.staleDays ? "ok" : "error", "Last sync", detail, days < config.staleDays ? undefined : state.lastFailure?.hint);
  }
  return results;
}

/** Every slot has a matching launchd wake-up in the installed plist. */
function slotMinutesInPlist(text, config) {
  return tickMinutes(config).every((m) => text.includes(`<key>Hour</key><integer>${Math.floor(m / 60)}</integer><key>Minute</key><integer>${m % 60}</integer>`));
}

function printChecks(results) {
  const icon = { ok: "✓", warn: "⚠", error: "✖" };
  for (const r of results) {
    console.log(`${icon[r.level]} ${r.name.padEnd(17)} ${r.detail}`);
    if (r.fix && r.level !== "ok") console.log(`  ${" ".repeat(17)} → ${r.fix}`);
  }
  const errors = results.filter((r) => r.level === "error").length;
  const warns = results.filter((r) => r.level === "warn").length;
  console.log(`\n${errors ? `${errors} problem(s)` : "All essential checks passed"}${warns ? `, ${warns} warning(s)` : ""}.`);
  return errors;
}

async function doctor() {
  if (printChecks(await runChecks())) process.exitCode = 1;
}

async function setup() {
  console.log("X Bookmarks sync — setup (safe to re-run; it only fixes what's missing)\n");
  const config = loadConfig();

  // 1. xrelay
  if (spawnSync(xrelayBin(), ["--version"], { encoding: "utf8" }).error?.code === "ENOENT") {
    console.log("▶ installing xrelay (npm i -g x-relay-mcp) …");
    const res = spawnSync(join(dirname(realpathSync(process.execPath)), "npm"), ["i", "-g", "x-relay-mcp"], { stdio: "inherit" });
    if (res.status !== 0) throw new Error("could not install xrelay");
  }
  const who = spawnSync(xrelayBin(), ["whoami"], { encoding: "utf8", env: { ...process.env, ...readEnvFile().vars }, timeout: 120_000 });
  console.log(who.status === 0 ? "✓ X: logged in" : "! X: not logged in — log into x.com in your browser (or run: npm run autosync -- set-cookies), then re-run setup");

  // 2. Cloudflare token
  const { vars } = readEnvFile();
  const { token } = resolveCloudflareToken(config, { ...vars, ...process.env }, new Set(Object.keys(vars)));
  if (!token) {
    console.log("▶ No Cloudflare API token yet — storing one in your login Keychain.");
    await setToken();
  } else {
    await verifyCloudflareToken(token);
  }

  // 3. URLs (inferred from the app's own config when possible)
  const envLocal = readRepoEnvLocal();
  const next = loadConfig();
  if (!next.workerUrl) {
    const fromEnv = /^https:\/\/.+workers\.dev/.test(envLocal.SEARCH_ENDPOINT ?? "") ? envLocal.SEARCH_ENDPOINT : "";
    next.workerUrl = fromEnv || prompt("Deployed search Worker URL (https://bookmark-search.<sub>.workers.dev, Enter to skip)", { hidden: false, optional: true }) || null;
  }
  if (!next.siteUrl && /^https:\/\//.test(envLocal.BETTER_AUTH_URL ?? "")) next.siteUrl = envLocal.BETTER_AUTH_URL;
  saveConfig(next);

  // 4. Schedule + notifier, then a test notification (macOS asks for permission the first time)
  install();
  notify({ title: "X Bookmarks Sync is set up", subtitle: "Notifications will look like this", message: "Click to open the sync status page." });
  console.log("✓ test notification sent — allow it if macOS asks\n");

  // 5. Health check
  console.log("Health check:");
  printChecks(await runChecks());
  console.log("\nRun the first sync now:  npm run autosync -- run");
}

const commands = {
  setup,
  doctor,
  install,
  uninstall,
  "set-token": setToken,
  "set-cookies": setCookies,
  status,
  run: runNow,
  open: openStatus,
  "notify-test": notifyTest,
  logs,
};
try {
  if (process.platform !== "darwin") throw new Error("the autopilot uses launchd + Keychain (macOS only); run scripts/auto-sync.mjs from cron elsewhere");
  const fn = commands[command];
  if (!fn) throw new Error(`unknown command "${command}" — use: ${Object.keys(commands).join(" | ")}`);
  await fn();
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}
