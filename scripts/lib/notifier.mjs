// Branded, clickable macOS notifications for the sync, with zero dependencies.
//
// `osascript -e 'display notification …'` posts as Script Editor (its icon, not clickable in any
// useful way). Instead, install builds a tiny AppleScript applet — ~/Applications/X Bookmarks
// Sync.app — with the X Bookmarks icon (scripts/assets/sync-icon.png). The sync writes the message
// to notify.json and launches the applet, which posts it AS ITSELF (name + icon) and quits.
// Clicking a notification relaunches the applet with no pending message, so it opens the status
// page (status.html, regenerated after every run). If the applet is missing, it falls back to
// plain osascript.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_DIR, LOG_DIR, REPO_ROOT } from "./autosync-config.mjs";

export const APP_NAME = "X Bookmarks Sync";
export const APP_PATH = join(homedir(), "Applications", `${APP_NAME}.app`);
export const APP_BUNDLE_ID = "com.xbookmarks.sync.notifier";
export const NOTIFY_PAYLOAD = join(CONFIG_DIR, "notify.json");
export const STATUS_PAGE = join(LOG_DIR, "status.html");
const ICON_PNG = join(REPO_ROOT, "scripts", "assets", "sync-icon.png");

const APPLET_SOURCE = `
on run
	set payloadPath to POSIX path of (path to home folder) & ".config/xbookmarks-sync/notify.json"
	set statusPath to POSIX path of (path to home folder) & "Library/Logs/xbookmarks-sync/status.html"
	set hasPayload to false
	try
		do shell script "test -s " & quoted form of payloadPath
		set hasPayload to true
	end try
	if hasPayload then
		set theTitle to my field("title", payloadPath)
		set theSubtitle to my field("subtitle", payloadPath)
		set theMessage to my field("message", payloadPath)
		do shell script "rm -f " & quoted form of payloadPath
		display notification theMessage with title theTitle subtitle theSubtitle
		delay 1
	else
		my openStatus(statusPath)
	end if
end run

on reopen
	my openStatus(POSIX path of (path to home folder) & "Library/Logs/xbookmarks-sync/status.html")
end reopen

on openStatus(statusPath)
	try
		do shell script "test -f " & quoted form of statusPath & " && open " & quoted form of statusPath
	end try
end openStatus

on field(theKey, payloadPath)
	try
		return do shell script "/usr/bin/plutil -extract " & theKey & " raw -o - " & quoted form of payloadPath
	on error
		return ""
	end try
end field
`;

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", ...opts });

/** (Re)build the notifier applet. Returns { ok, error? }. Idempotent. */
export function buildNotifierApp() {
  const work = mkdtempSync(join(tmpdir(), "xbm-notifier-"));
  try {
    mkdirSync(join(homedir(), "Applications"), { recursive: true });
    const script = join(work, "notifier.applescript");
    writeFileSync(script, APPLET_SOURCE);
    rmSync(APP_PATH, { recursive: true, force: true });
    let res = run("/usr/bin/osacompile", ["-o", APP_PATH, script]);
    if (res.status !== 0) return { ok: false, error: `osacompile: ${res.stderr.trim()}` };

    const plist = join(APP_PATH, "Contents", "Info.plist");
    const set = (key, type, value) => {
      run("/usr/bin/plutil", ["-remove", key, plist]);
      run("/usr/bin/plutil", ["-insert", key, `-${type}`, value, plist]);
    };
    set("CFBundleIdentifier", "string", APP_BUNDLE_ID);
    set("CFBundleName", "string", APP_NAME);
    set("CFBundleDisplayName", "string", APP_NAME);
    set("LSUIElement", "bool", "true"); // no Dock icon while it posts
    set("CFBundleIconFile", "string", "applet");
    run("/usr/bin/plutil", ["-remove", "CFBundleIconName", plist]); // else the Assets.car icon wins
    rmSync(join(APP_PATH, "Contents", "Resources", "Assets.car"), { force: true });

    if (existsSync(ICON_PNG)) {
      const iconset = join(work, "applet.iconset");
      mkdirSync(iconset);
      for (const size of [16, 32, 128, 256, 512]) {
        run("/usr/bin/sips", ["-z", String(size), String(size), ICON_PNG, "--out", join(iconset, `icon_${size}x${size}.png`)]);
        run("/usr/bin/sips", ["-z", String(size * 2), String(size * 2), ICON_PNG, "--out", join(iconset, `icon_${size}x${size}@2x.png`)]);
      }
      res = run("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", join(APP_PATH, "Contents", "Resources", "applet.icns")]);
      if (res.status !== 0) return { ok: false, error: `iconutil: ${res.stderr.trim()}` };
    }

    // Ad-hoc signature after editing the bundle (an unsigned/modified applet won't launch cleanly).
    res = run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", APP_PATH]);
    if (res.status !== 0) return { ok: false, error: `codesign: ${res.stderr.trim()}` };
    run("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", APP_PATH]);
    return { ok: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function notifierInstalled() {
  return existsSync(join(APP_PATH, "Contents", "MacOS"));
}

/** Post a notification as "X Bookmarks Sync" (falls back to plain osascript). */
export function notify({ title, subtitle = "", message }) {
  if (notifierInstalled()) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(NOTIFY_PAYLOAD, JSON.stringify({ title, subtitle, message }), { mode: 0o600 });
    // -g: don't steal focus; -j: launch hidden.
    const res = run("/usr/bin/open", ["-g", "-j", "-a", APP_PATH]);
    if (res.status === 0) return;
  }
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const subtitlePart = subtitle ? ` subtitle "${esc(subtitle)}"` : "";
  run("/usr/bin/osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"${subtitlePart}`]);
}

// ---------------------------------------------------------------- status page

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function ago(iso, now = Date.now()) {
  if (!iso) return "never";
  const mins = Math.round((now - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Regenerate status.html from the state + run history (+ the latest run's log tail). */
export function writeStatusPage({ state, runs, config, health, nextAttempt, logTail }) {
  const tone = { ok: ["#16a34a", "Healthy"], warn: ["#d97706", "Needs attention"], error: ["#dc2626", "Failing"] }[health.level];
  const failure = state.lastFailure && health.level !== "ok" ? state.lastFailure : null;
  const rows = runs
    .map((r) => {
      const result = r.skipped ? "skipped" : r.ok ? "✓" : `✖ ${escapeHtml(r.code ?? "")}`;
      const detail = r.ok ? `+${r.added ?? 0}${r.uploaded ? " · published" : ""}` : escapeHtml(r.error ?? "");
      return `<tr><td>${escapeHtml(new Date(r.startedAt).toLocaleString())}</td><td class="${r.ok ? "ok" : "bad"}">${result}</td><td>${detail}</td><td>${Math.round((r.ms ?? 0) / 1000)}s</td></tr>`;
    })
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>X Bookmarks Sync</title>
<style>
:root{color-scheme:light dark;--bg:#f4f4f5;--card:#fff;--ink:#09090b;--muted:#71717a;--line:#e4e4e7}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--card:#18181b;--ink:#fafafa;--muted:#a1a1aa;--line:#27272a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,Inter,sans-serif}
main{max-width:820px;margin:0 auto;padding:40px 20px}h1{font:600 28px/1.2 Georgia,serif;margin:0 0 4px}
.muted{color:var(--muted)}.card{background:var(--card);border-radius:16px;padding:20px;margin-top:16px;box-shadow:0 1px 2px rgb(0 0 0/.05)}
.pill{display:inline-flex;align-items:center;gap:8px;font-weight:600}.dot{width:10px;height:10px;border-radius:50%;background:${tone[0]}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.k{font-size:12px;color:var(--muted)}.v{font-size:18px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:6px 4px;border-top:1px solid var(--line);vertical-align:top}.ok{color:#16a34a}.bad{color:#dc2626}
code,pre{font:12px/1.5 ui-monospace,Menlo,monospace}pre{white-space:pre-wrap;max-height:360px;overflow:auto;margin:0}
.fix{border-left:3px solid ${tone[0]};padding-left:12px}a{color:inherit}button{font:inherit;border:0;border-radius:999px;padding:6px 12px;background:var(--ink);color:var(--card);cursor:pointer}
</style></head><body><main>
<h1>X Bookmarks Sync</h1><div class="muted">Updated ${escapeHtml(new Date().toLocaleString())}</div>
<div class="card"><div class="pill"><span class="dot"></span>${tone[1]}</div><p class="muted" style="margin:6px 0 0">${escapeHtml(health.summary)}</p>
${failure ? `<div class="fix" style="margin-top:14px"><b>${escapeHtml(failure.title)}</b><div>${escapeHtml(failure.hint ?? "")}</div><div class="muted" style="margin-top:4px"><code>${escapeHtml(failure.message)}</code></div></div>` : ""}</div>
<div class="card grid">
<div><div class="k">Last successful sync</div><div class="v">${escapeHtml(ago(state.lastSuccessAt))}</div></div>
<div><div class="k">Next attempt</div><div class="v">${escapeHtml(nextAttempt)}</div></div>
<div><div class="k">Attempts today</div><div class="v">${state.attemptsToday ?? 0} / ${config.maxAttemptsPerDay}</div></div>
<div><div class="k">Live data version</div><div class="v">${escapeHtml(state.lastUploaded?.version ?? "—")}</div></div>
</div>
<div class="card"><div class="k">Run it now</div><p style="margin:6px 0"><code>npm run autosync -- run</code> <button onclick="navigator.clipboard.writeText('npm run autosync -- run')">Copy</button> &nbsp; Health check: <code>npm run autosync -- doctor</code></p>
${config.siteUrl ? `<p style="margin:6px 0"><a href="${escapeHtml(config.siteUrl)}">Open X Bookmarks →</a></p>` : ""}</div>
<div class="card"><div class="k">Recent runs</div><table>${rows || '<tr><td class="muted">No runs yet</td></tr>'}</table></div>
${logTail ? `<div class="card"><div class="k">Latest log</div><pre>${escapeHtml(logTail)}</pre></div>` : ""}
</main></body></html>`;
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(STATUS_PAGE, html);
}

/** Overall health from state: ok / warn / error + a one-line summary. */
export function computeHealth(state, config, now = Date.now()) {
  const lastSuccess = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : null;
  const ageDays = lastSuccess ? (now - lastSuccess) / 86_400_000 : Infinity;
  if (state.consecutiveFailures === 0 && ageDays < 2) {
    return { level: "ok", summary: `Synced ${ago(state.lastSuccessAt, now)}. Runs daily at ${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")}, retries on its own.` };
  }
  if (ageDays >= config.staleDays || state.lastFailure?.retryable === false) {
    return { level: "error", summary: lastSuccess ? `No successful sync for ${Math.floor(ageDays)} day(s).` : "No successful sync yet." };
  }
  return { level: "warn", summary: `Last attempt failed; it retries automatically. Last success ${ago(state.lastSuccessAt, now)}.` };
}

export function readLogTail(path, lines = 60) {
  try {
    return readFileSync(path, "utf8").split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}
