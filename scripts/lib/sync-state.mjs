// Persistent autopilot state (~/.config/xbookmarks-sync/state.json) + the pure "should this tick
// run?" decision, the O_EXCL run lock, and the run history (runs.jsonl).
//
// The day has sync SLOTS (config.slots, local "HH:MM", default 11:00 + 14:00). launchd fires the
// job every hour, at each slot and at login. Each tick asks shouldRun() about the most recent slot
// at or before now — today's, or before today's first slot, yesterday's last:
//   • a sync succeeded since that slot (or just before it) → skip
//   • out of attempts for today                            → skip (max config.maxAttemptsPerDay)
//   • too soon after a failed attempt                      → skip (config.retryHours; offline: next tick)
//   • otherwise                                            → run (a missed slot is caught up at the
//                                                            next tick the Mac is awake)
// A manual `npm run autosync -- run` sets a one-shot force marker that bypasses all of this.
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;

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
  threadsBacklogDay: null, // local day the author-threads backlog last ran (once a day, not per slot)
  notified: {}, // { "<code>:<day>": true } — one failure notification per cause per day
  staleNotifiedAt: null,
};

// ------------------------------------------------------------------ slots

/** "HH:MM" strings → sorted, de-duplicated minutes after midnight. Throws on a malformed slot. */
export function parseSlots(slots) {
  const minutes = slots.map((slot) => {
    const m = String(slot).trim().match(/^(\d{1,2}):(\d{2})$/);
    const value = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`invalid sync slot "${slot}" — use HH:MM, e.g. 11:00`);
    return value;
  });
  if (!minutes.length) throw new Error("at least one sync slot is needed");
  return [...new Set(minutes)].sort((a, b) => a - b);
}

/** The config's slots as minutes; a pre-slots config ({ hour, minute }) is one daily slot. */
export function slotMinutes(config) {
  if (Array.isArray(config.slots) && config.slots.length) return parseSlots(config.slots);
  return [(config.hour ?? 14) * 60 + (config.minute ?? 0)];
}

export const formatSlot = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** "11:00 and 14:00" */
export function describeSlots(config) {
  const labels = slotMinutes(config).map(formatSlot);
  return labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function atMinutes(date, minutes) {
  const d = new Date(date);
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return d;
}

/** The most recent slot instant at or before `now`: today's, or yesterday's last before today's first. */
export function lastSlotAt(slots, now) {
  const mins = now.getHours() * 60 + now.getMinutes();
  const today = slots.filter((s) => s <= mins);
  if (today.length) return atMinutes(now, today.at(-1));
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  return atMinutes(yesterday, slots.at(-1));
}

/** How long before a slot a success still counts for it — a login catch-up at 10:40 covers 11:00, a
 *  13:20 retry covers 14:00. Half the shortest gap between slots (so one run never covers two), ≤ 90 min. */
export function slotGraceMs(slots) {
  if (slots.length === 1) return 90 * MINUTE;
  const gaps = slots.map((s, i) => (i === 0 ? s + DAY_MINUTES - slots.at(-1) : s - slots[i - 1]));
  return Math.min(90, Math.floor(Math.min(...gaps) / 2)) * MINUTE;
}

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

/** Attempts counted against today (the stored counter belongs to `state.day`). */
export function attemptsToday(state, now = new Date()) {
  return state.day === localDay(now) ? state.attemptsToday : 0;
}

/**
 * Pure scheduling decision. `now` is a Date; config has slots, maxAttemptsPerDay, retryHours.
 * Returns { run, reason }.
 */
export function shouldRun(state, config, now) {
  const slots = slotMinutes(config);
  const due = lastSlotAt(slots, now);
  const lastSuccess = state.lastSuccessAt ? new Date(state.lastSuccessAt) : null;
  const label = formatSlot(due.getHours() * 60 + due.getMinutes());

  if (lastSuccess && lastSuccess.getTime() >= due.getTime() - slotGraceMs(slots)) {
    return { run: false, reason: `up to date for the ${label} slot` };
  }

  const attempts = attemptsToday(state, now);
  if (attempts >= config.maxAttemptsPerDay) return { run: false, reason: `gave up for today after ${attempts} attempts` };

  if (state.lastAttemptAt && state.lastAttemptCode) {
    // Offline: try again on the very next tick. Anything else: wait retryHours between attempts.
    const spacing = state.lastAttemptCode === "OFFLINE" ? 0.75 * HOUR : config.retryHours * HOUR;
    const since = now - new Date(state.lastAttemptAt);
    if (since < spacing) return { run: false, reason: `retrying ${Math.ceil((spacing - since) / MINUTE)} min after the last failure` };
  }
  return { run: true, reason: localDay(due) === localDay(now) ? `due (${label} slot)` : `catching up yesterday's ${label} slot` };
}

/** launchd's wake-up times: every hour on the hour plus each slot (minutes after midnight). */
export function tickMinutes(config) {
  const hourly = Array.from({ length: 24 }, (_, h) => h * 60);
  return [...new Set([...hourly, ...slotMinutes(config)])].sort((a, b) => a - b);
}

/** When the next launchd tick would actually run a sync, or null within 3 days. */
export function nextRunAt(state, config, from = new Date()) {
  const ticks = tickMinutes(config);
  for (let day = 0; day < 3; day += 1) {
    const date = new Date(from);
    date.setDate(date.getDate() + day);
    for (const minutes of ticks) {
      const tick = atMinutes(date, minutes);
      if (tick <= from) continue;
      const simulated = rollDay(structuredClone(state), tick);
      if (shouldRun(simulated, config, tick).run) return tick;
    }
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
