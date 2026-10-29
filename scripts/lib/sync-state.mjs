// Persistent autopilot state (~/.config/xbookmarks-sync/state.json) + the pure "should this tick
// run?" decision, the O_EXCL run lock, and the run history (runs.jsonl).
//
// launchd fires the job every hour (and at login). Each tick asks shouldRun():
//   • already synced today                       → skip
//   • before today's slot (config.hour:minute)   → skip, unless the last success is > 26h old
//                                                  (the Mac was off/asleep yesterday — catch up now)
//   • out of attempts for today                  → skip (max config.maxAttemptsPerDay)
//   • too soon after a failed attempt            → skip (config.retryHours; offline: next tick)
//   • otherwise                                  → run
// A manual `npm run autosync -- run` sets a one-shot force marker that bypasses all of this.
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";

const HOUR = 3_600_000;

export const EMPTY_STATE = {
  day: null, // local YYYY-MM-DD the attempt counter belongs to
  attemptsToday: 0,
  lastAttemptAt: null,
  lastAttemptCode: null, // error code of the last FAILED attempt (null after a success)
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastFailure: null, // { code, title, message, at }
  lastUploaded: null, // { fingerprint, version, at }
  lastXrelayCheckAt: null,
  notified: {}, // { "<code>:<day>": true } — one failure notification per cause per day
  staleNotifiedAt: null,
};

export function localDay(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function loadState(path) {
  if (!existsSync(path)) return structuredClone(EMPTY_STATE);
  try {
    return { ...structuredClone(EMPTY_STATE), ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return structuredClone(EMPTY_STATE); // corrupt state must never block syncing
  }
}

export function saveState(path, state) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** Reset the per-day attempt counter when the local day changed. Returns the state (mutated). */
export function rollDay(state, now) {
  const today = localDay(now);
  if (state.day !== today) {
    state.day = today;
    state.attemptsToday = 0;
  }
  return state;
}

/**
 * Pure scheduling decision. `now` is a Date; config has hour, minute, maxAttemptsPerDay, retryHours.
 * Returns { run, reason }.
 */
export function shouldRun(state, config, now) {
  const today = localDay(now);
  const attempts = state.day === today ? state.attemptsToday : 0;
  const lastSuccess = state.lastSuccessAt ? new Date(state.lastSuccessAt) : null;

  if (lastSuccess && localDay(lastSuccess) === today) return { run: false, reason: "already synced today" };

  const slot = new Date(now);
  slot.setHours(config.hour, config.minute, 0, 0);
  const overdue = !lastSuccess || now - lastSuccess > 26 * HOUR;
  if (now < slot && !overdue) return { run: false, reason: `waiting for today's ${String(config.hour).padStart(2, "0")}:${String(config.minute).padStart(2, "0")} slot` };

  if (attempts >= config.maxAttemptsPerDay) return { run: false, reason: `gave up for today after ${attempts} attempts` };

  if (state.lastAttemptAt && state.lastAttemptCode) {
    // Offline: try again on the very next tick. Anything else: wait retryHours between attempts.
    const spacing = state.lastAttemptCode === "OFFLINE" ? 0.75 * HOUR : config.retryHours * HOUR;
    const since = now - new Date(state.lastAttemptAt);
    if (since < spacing) return { run: false, reason: `retrying ${Math.ceil((spacing - since) / 60_000)} min after the last failure` };
  }
  return { run: true, reason: overdue && now < slot ? "catching up a missed day" : "due" };
}

/** When the next scheduled (hourly, at config.minute) tick would actually run, or null within 3 days. */
export function nextRunAt(state, config, from = new Date()) {
  const tick = new Date(from);
  tick.setMinutes(config.minute, 0, 0);
  if (tick <= from) tick.setTime(tick.getTime() + HOUR);
  for (let i = 0; i < 72; i += 1, tick.setTime(tick.getTime() + HOUR)) {
    const simulated = rollDay(structuredClone(state), tick);
    if (shouldRun(simulated, config, tick).run) return new Date(tick);
  }
  return null;
}

export function formatWhen(date, from = new Date()) {
  if (!date) return "—";
  const day = localDay(date) === localDay(from) ? "today" : localDay(date) === localDay(from.getTime() + 24 * HOUR) ? "tomorrow" : localDay(date);
  return `${day} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Upload when the local artifacts differ from what was last published successfully. */
export function shouldUpload(fingerprint, state, force = false) {
  return force || state.lastUploaded?.fingerprint !== fingerprint;
}

const LOCK_MAX_AGE_MS = 3 * HOUR; // a run never legitimately takes this long

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Atomic single-instance lock: O_EXCL create, so two runs can't both win. A lock whose pid is gone,
 * or that is older than LOCK_MAX_AGE_MS (pid reused by another process), is stale and replaced.
 * Returns { ok: true } or { ok: false, holder }.
 */
export function acquireLock(path, now = Date.now()) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date(now).toISOString() }));
      closeSync(fd);
      return { ok: true };
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      let holder = null;
      try {
        const raw = readFileSync(path, "utf8").trim();
        holder = raw.startsWith("{") ? JSON.parse(raw) : { pid: Number(raw), startedAt: null };
      } catch {
        holder = null;
      }
      const age = holder?.startedAt ? now - Date.parse(holder.startedAt) : 0;
      const live = holder?.pid && pidAlive(holder.pid) && age < LOCK_MAX_AGE_MS;
      if (live) return { ok: false, holder };
      try {
        unlinkSync(path); // stale — remove and try once more
      } catch {
        /* someone else just did */
      }
    }
  }
  return { ok: false, holder: null };
}

export function releaseLock(path) {
  try {
    const raw = readFileSync(path, "utf8").trim();
    const pid = raw.startsWith("{") ? JSON.parse(raw).pid : Number(raw);
    if (pid === process.pid) unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/** Append one run summary to runs.jsonl, keeping the newest `keep` lines. */
export function appendRun(path, run, keep = 60) {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
  lines.push(JSON.stringify(run));
  writeFileSync(`${path}.tmp`, `${lines.slice(-keep).join("\n")}\n`);
  renameSync(`${path}.tmp`, path);
}

export function readRuns(path, limit = 20) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}
