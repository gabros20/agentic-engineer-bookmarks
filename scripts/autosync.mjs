#!/usr/bin/env node
// Control the bookmark-sync autopilot: a per-user launchd agent that runs scripts/auto-sync.mjs daily.
// LaunchAgents live in ~/Library/LaunchAgents and load at login, so the schedule survives restarts;
// if the Mac is asleep at the scheduled time, launchd runs the job once on wake.
//
//   npm run autosync -- install [--hour 14] [--minute 0] [--notify changes|always|failure|never]
//                               [--browser chrome] [--account-id <cf-account>] [--update-xrelay]
//   npm run autosync -- set-token --env-file   write it to ~/.config/xbookmarks-sync/env (chmod 600) —
//                                        best for a headless Mac mini (no keychain unlock / 1Password)
//   npm run autosync -- set-cookies      put XRELAY_COOKIES (X auth_token + ct0) in the env file, so xrelay
//                                        needs no logged-in browser on the box
//   npm run autosync -- set-token        store the Cloudflare API token in the login Keychain, OR
//   npm run autosync -- set-token --1password "op://Vault/Item/credential"   read it from 1Password
//   npm run autosync -- set-token --op-service-account   store a 1Password service-account token
//                                        (Keychain) so the op:// read runs unattended, no Touch ID
//   npm run autosync -- status           schedule, agent state, auth, last run
//   npm run autosync -- run              start the agent NOW (same environment as the daily run)
//   npm run autosync -- logs             print the latest run log
//   npm run autosync -- uninstall        unload + remove the agent (config/logs kept)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  CONFIG_PATH,
  ENV_FILE_PATH,
  KEYCHAIN_OP_SA_ACCOUNT,
  KEYCHAIN_SERVICE,
  KEYCHAIN_TOKEN_ACCOUNT,
  LABEL,
  LAST_RUN_PATH,
  LOG_DIR,
  PLIST_PATH,
  REPO_ROOT,
  loadConfig,
  readEnvFile,
  readKeychainSecret,
  readKeychainToken,
  readOnePassword,
  saveConfig,
  writeEnvFileVar,
} from "./lib/autosync-config.mjs";

const [command = "status", ...rest] = process.argv.slice(2);
const uid = process.getuid();
const domain = `gui/${uid}`;
const service = `${domain}/${LABEL}`;

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

function plist({ node, hour, minute }) {
  // Real path of the node binary: version managers (fnm/nvm) hand shells a per-session symlink that
  // disappears; launchd needs the stable install path. Its bin dir also holds npx + global xrelay.
  const path = [dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(node)}</string>
    <string>${xmlEscape(join(REPO_ROOT, "scripts", "auto-sync.mjs"))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xmlEscape(REPO_ROOT)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(path)}</string>
    <key>HOME</key><string>${xmlEscape(process.env.HOME)}</string>
  </dict>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>${xmlEscape(join(LOG_DIR, "launchd.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(join(LOG_DIR, "launchd.err.log"))}</string>
</dict>
</plist>
`;
}

function install() {
  const config = loadConfig();
  const hour = flag("hour") !== undefined ? Number(flag("hour")) : config.hour;
  const minute = flag("minute") !== undefined ? Number(flag("minute")) : config.minute;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error("--hour must be 0-23 and --minute 0-59");
  }
  const notify = flag("notify") ?? config.notify;
  if (!["always", "changes", "failure", "never"].includes(notify)) throw new Error("--notify: always|changes|failure|never");
  const next = {
    ...config,
    hour,
    minute,
    notify,
    xrelayBrowser: flag("browser") ?? config.xrelayBrowser,
    cloudflareAccountId: flag("account-id") ?? config.cloudflareAccountId,
    updateXrelay: rest.includes("--update-xrelay") ? true : config.updateXrelay,
  };
  saveConfig(next);

  const node = realpathSync(process.execPath);
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(dirname(PLIST_PATH), { recursive: true });
  writeFileSync(PLIST_PATH, plist({ node, hour, minute }));

  launchctl("bootout", service); // ignore "not loaded"
  const res = launchctl("bootstrap", domain, PLIST_PATH);
  if (res.status !== 0) throw new Error(`launchctl bootstrap failed: ${(res.stderr || res.stdout).trim()}`);

  console.log(`✓ installed ${LABEL}: daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
  console.log(`  node   ${node}`);
  console.log(`  plist  ${PLIST_PATH}`);
  console.log(`  config ${CONFIG_PATH}`);
  if (!readKeychainToken() && !next.cloudflareTokenRef && !readEnvFile().vars.CLOUDFLARE_API_TOKEN) {
    console.log("\n! No Cloudflare API token configured yet. Unattended runs need one (wrangler's browser login");
    console.log("  expires and can't refresh without you). Run:  npm run autosync -- set-token [--env-file | --1password op://…]");
  }
  console.log("\nTest it under launchd now:  npm run autosync -- run   (then: npm run autosync -- status)");
}

function uninstall() {
  launchctl("bootout", service);
  if (existsSync(PLIST_PATH)) rmSync(PLIST_PATH);
  console.log(`✓ removed ${LABEL} (config ${CONFIG_PATH} and logs ${LOG_DIR} kept)`);
}

const TOKEN_HELP =
  "Cloudflare API token (dash.cloudflare.com → My Profile → API Tokens → Create), scoped to your account:\n" +
  "  Account · Workers R2 Storage: Edit   (upload/restore the bookmark-search-data bucket)\n" +
  "  Account · Workers AI: Read           (embed new posts with bge-m3)\n" +
  "  Account · Workers Scripts: Edit      (wrangler dev's remote preview for the AI binding)\n" +
  "  Account · Account Settings: Read     (wrangler whoami / account lookup)\n" +
  "  (the \"Edit Cloudflare Workers\" template + Workers AI also works — broader, simpler)\n";

/** Store a secret in the login Keychain; `-w` LAST makes `security` prompt for it (hidden, never in argv/history). */
function storeKeychainSecret(account, label) {
  const res = spawnSync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-l", label, "-w"],
    { stdio: "inherit" },
  );
  if (res.status !== 0) throw new Error("could not store the secret in the Keychain");
}

/** Ask wrangler whether Cloudflare accepts the token. */
function verifyCloudflareToken(token) {
  const npx = join(dirname(realpathSync(process.execPath)), "npx");
  const who = spawnSync(npx, ["--yes", "wrangler", "whoami"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CI: "1" },
  });
  const out = `${who.stdout}${who.stderr}`;
  if (who.status === 0 && !/not (logged in|authenticated)/i.test(out)) {
    console.log("✓ Cloudflare accepted the token");
    if (new Set(out.match(/[0-9a-f]{32}/g) ?? []).size > 1) {
      console.log("! The token sees several accounts — pin one: npm run autosync -- install --account-id <id>");
    }
    return;
  }
  console.log(`! Cloudflare rejected the token:\n${out.trim().split("\n").slice(-5).join("\n")}`);
  process.exitCode = 1;
}

/** Read one line from the terminal without echoing it (never in argv or shell history). */
function promptHidden(label) {
  const res = spawnSync("/bin/bash", ["-c", `read -rs -p "${label}: " V; echo >&2; printf %s "$V"`], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  const value = (res.stdout ?? "").trim();
  if (res.status !== 0 || !value) throw new Error("nothing entered");
  return value;
}

function setCookies() {
  console.log(
    "X session cookies for xrelay (lets a headless box pull bookmarks without a logged-in browser).\n" +
      "In a browser logged into x.com: DevTools → Application → Cookies → https://x.com → copy `auth_token` and `ct0`.\n" +
      "They last until you log out of that X session; re-run this if `xrelay whoami` starts failing.\n",
  );
  const authToken = promptHidden("auth_token");
  const ct0 = promptHidden("ct0");
  writeEnvFileVar("XRELAY_COOKIES", `auth_token=${authToken}; ct0=${ct0}`);
  const who = spawnSync(join(dirname(realpathSync(process.execPath)), "xrelay"), ["whoami"], {
    encoding: "utf8",
    env: { ...process.env, XRELAY_COOKIES: `auth_token=${authToken}; ct0=${ct0}` },
  });
  console.log(who.status === 0 ? `✓ saved to ${ENV_FILE_PATH} and X accepted the cookies` : `! saved, but xrelay whoami failed:\n${`${who.stdout}${who.stderr}`.trim().slice(-400)}`);
  if (who.status !== 0) process.exitCode = 1;
}

function setToken() {
  if (rest.includes("--env-file")) {
    console.log(`${TOKEN_HELP}\nIt is written to ${ENV_FILE_PATH} (mode 600, outside the repo).\n`);
    const token = promptHidden("Cloudflare API token");
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
    if (!configured) return console.log("Next: npm run autosync -- set-token --1password \"op://Vault/Item/credential\"");
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
    verifyCloudflareToken(res.value);
    saveConfig({ ...loadConfig(), cloudflareTokenRef: ref });
    console.log(`✓ saved the reference to ${CONFIG_PATH} (the token itself is never written to disk)`);
    if (!readKeychainSecret(KEYCHAIN_OP_SA_ACCOUNT)) {
      console.log(
        "\nNote: without a 1Password service account, each daily run asks the 1Password app (Touch ID) and\n" +
          "fails if it's locked. For fully unattended runs: npm run autosync -- set-token --op-service-account",
      );
    }
    return;
  }
  console.log(`${TOKEN_HELP}\nPaste it at the prompt (hidden). It is stored in your login Keychain, never on disk.\n`);
  storeKeychainSecret(KEYCHAIN_TOKEN_ACCOUNT, "X Bookmarks sync (Cloudflare API token)");
  verifyCloudflareToken(readKeychainToken());
}

function status() {
  const config = loadConfig();
  const installed = existsSync(PLIST_PATH);
  console.log(`Autopilot   ${installed ? "installed" : "NOT installed"} (${LABEL})`);
  console.log(`Schedule    daily ${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")} · notify: ${config.notify} · update xrelay: ${config.updateXrelay}`);
  if (installed) {
    const printed = launchctl("print", service);
    if (printed.status === 0) {
      const pick = (key) => printed.stdout.match(new RegExp(`\\n\\s*${key} = ([^\\n]+)`))?.[1]?.trim();
      console.log(`Agent       loaded · state ${pick("state") ?? "?"} · runs ${pick("runs") ?? "0"} · last exit ${pick("last exit code") ?? "n/a"}`);
    } else {
      console.log("Agent       plist present but NOT loaded — run: npm run autosync -- install");
    }
    const node = readFileSync(PLIST_PATH, "utf8").match(/<array>\s*<string>([^<]+)<\/string>/)?.[1];
    if (node && !existsSync(node)) console.log(`! node binary is gone (${node}) — reinstall after a Node upgrade: npm run autosync -- install`);
  }
  // Describe the token source without reading it (an op read could trigger a Touch ID prompt).
  const sources = [];
  const { vars: envVars, warning: envWarning } = readEnvFile();
  if (process.env.CLOUDFLARE_API_TOKEN) sources.push("CLOUDFLARE_API_TOKEN env ✓");
  if (envVars.CLOUDFLARE_API_TOKEN) sources.push(`env file ✓ (${ENV_FILE_PATH})`);
  if (config.cloudflareTokenRef) {
    sources.push(`1Password ${config.cloudflareTokenRef} (${readKeychainSecret(KEYCHAIN_OP_SA_ACCOUNT) ? "service account ✓, unattended" : "via the app — Touch ID each run"})`);
  }
  if (readKeychainToken()) sources.push("Keychain API token ✓");
  console.log(`Cloudflare  ${sources.length ? sources.join(" → then ") : "no token — falls back to `wrangler login` (expires!)"}`);
  console.log(`X auth      ${envVars.XRELAY_COOKIES || process.env.XRELAY_COOKIES ? "XRELAY_COOKIES (env file/env) ✓" : `browser cookies${config.xrelayBrowser ? ` (${config.xrelayBrowser})` : ""} — needs a logged-in browser on this Mac`}`);
  if (envWarning) console.log(`! ${envWarning}`);
  if (existsSync(LAST_RUN_PATH)) {
    const last = JSON.parse(readFileSync(LAST_RUN_PATH, "utf8"));
    const verdict = last.ok ? "✓ ok" : `✖ ${last.error}`;
    const detail = last.after ? ` · +${last.added} → ${last.after.count} bookmarks${last.uploaded ? " · published" : " · no upload"}` : "";
    console.log(`Last run    ${last.finishedAt} ${last.dryRun ? "(dry run) " : ""}${verdict}${detail}`);
    for (const w of last.warnings ?? []) console.log(`            ⚠ ${w}`);
    console.log(`Log         ${last.log}`);
  } else {
    console.log("Last run    never");
  }
}

function runNow() {
  if (!existsSync(PLIST_PATH)) throw new Error("not installed — run: npm run autosync -- install");
  const res = launchctl("kickstart", service);
  if (res.status !== 0) throw new Error(`kickstart failed: ${(res.stderr || res.stdout).trim()}`);
  console.log(`▶ started ${LABEL} under launchd. Follow along: tail -f "${join(LOG_DIR, "launchd.out.log")}"`);
}

function logs() {
  const files = existsSync(LOG_DIR) ? readdirSync(LOG_DIR).filter((f) => /^sync-.*\.log$/.test(f)).sort() : [];
  if (!files.length) return console.log("no runs yet");
  process.stdout.write(readFileSync(join(LOG_DIR, files.at(-1)), "utf8"));
}

const commands = { install, uninstall, "set-token": setToken, "set-cookies": setCookies, status, run: runNow, logs };
try {
  if (process.platform !== "darwin") throw new Error("the autopilot uses launchd + Keychain (macOS only); run scripts/auto-sync.mjs from cron elsewhere");
  const fn = commands[command];
  if (!fn) throw new Error(`unknown command "${command}" — use: ${Object.keys(commands).join(" | ")}`);
  fn();
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}
