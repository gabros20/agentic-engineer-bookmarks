// Unit tests for the sync autopilot's decision logic (scheduling, error classification, lock,
// publish decision). Plain node:assert, no framework (matches scripts/test-search-core.mjs).
// Run via `npm run test:autosync`.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyError } from "./lib/sync-errors.mjs";
import { EMPTY_STATE, acquireLock, appendRun, attemptsToday, nextRunAt, readRuns, releaseLock, rollDay, shouldRun, shouldUpload, slotGraceMs, parseSlots, tickMinutes } from "./lib/sync-state.mjs";

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok   - ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL - ${name}`);
    console.log(`       ${err.message}`);
  }
}

const config = { slots: ["11:00", "14:00"], maxAttemptsPerDay: 6, retryHours: 2 };
const at = (day, hh, mm = 0) => new Date(2026, 9, day, hh, mm); // local time, Oct 2026
const state = (patch = {}) => ({ ...structuredClone(EMPTY_STATE), ...patch });
const iso = (d) => d.toISOString();
const runs = (s, d) => shouldRun(s, config, d).run;

// ---------------------------------------------------------------- scheduling (slots 11:00 + 14:00)

test("before 11:00, yesterday's 14:00 slot done → skip", () => {
  const s = state({ lastSuccessAt: iso(at(28, 14, 20)) });
  assert.equal(runs(s, at(29, 9)), false);
  assert.equal(runs(s, at(29, 10, 59)), false);
});

test("11:00 slot due → run; after it succeeds, wait for 14:00", () => {
  const s = state({ lastSuccessAt: iso(at(28, 14, 20)) });
  assert.equal(runs(s, at(29, 11)), true);
  const after = state({ lastSuccessAt: iso(at(29, 11, 15)) });
  assert.equal(runs(after, at(29, 12)), false);
  assert.equal(runs(after, at(29, 13)), false);
  assert.equal(runs(after, at(29, 14)), true);
});

test("after the 14:00 run, nothing until tomorrow 11:00", () => {
  const s = state({ lastSuccessAt: iso(at(29, 14, 12)) });
  for (const hh of [15, 18, 23]) assert.equal(runs(s, at(29, hh)), false);
  assert.equal(runs(s, at(30, 3)), false);
  assert.equal(runs(s, at(30, 11)), true);
});

test("Mac asleep at 14:00 → the slot is caught up at the next tick", () => {
  const s = state({ lastSuccessAt: iso(at(29, 11, 10)) });
  assert.equal(runs(s, at(29, 19)), true);
});

test("missed yesterday's slots → catch up before today's first slot", () => {
  const s = state({ lastSuccessAt: iso(at(27, 14, 5)) });
  const decision = shouldRun(s, config, at(29, 8));
  assert.equal(decision.run, true);
  assert.match(decision.reason, /catching up/);
});

test("a catch-up just before a slot covers it (no second run 30 min later)", () => {
  const s = state({ lastSuccessAt: iso(at(29, 10, 35)) });
  assert.equal(runs(s, at(29, 11)), false);
  assert.equal(runs(s, at(29, 14)), true);
});

test("a late 11:00 retry that lands near 14:00 covers 14:00", () => {
  const s = state({ lastSuccessAt: iso(at(29, 13, 20)) });
  assert.equal(runs(s, at(29, 14)), false);
});

test("an 11:00 run never covers 14:00 (grace is half the gap, ≤ 90 min)", () => {
  const slots = parseSlots(config.slots);
  assert.equal(slotGraceMs(slots), 90 * 60_000);
  assert.equal(slotGraceMs(parseSlots(["11:00", "12:00"])), 30 * 60_000);
  const s = state({ lastSuccessAt: iso(at(29, 12, 20)) });
  assert.equal(runs(s, at(29, 14)), true);
});

test("never synced → run immediately", () => {
  assert.equal(runs(state(), at(29, 3)), true);
});

test("failed attempt → wait retryHours before the next one", () => {
  const s = state({ lastSuccessAt: iso(at(28, 14)), day: "2026-10-29", attemptsToday: 1, lastAttemptAt: iso(at(29, 11)), lastAttemptCode: "EMBED" });
  assert.equal(runs(s, at(29, 12)), false);
  assert.equal(runs(s, at(29, 13)), true);
});

test("offline attempt → retry on the next hourly tick", () => {
  const s = state({ lastSuccessAt: iso(at(28, 14)), day: "2026-10-29", attemptsToday: 0, lastAttemptAt: iso(at(29, 11)), lastAttemptCode: "OFFLINE" });
  assert.equal(runs(s, at(29, 12)), true);
});

test("attempt cap → give up for the day, fresh budget tomorrow", () => {
  const s = state({ lastSuccessAt: iso(at(28, 14)), day: "2026-10-29", attemptsToday: 6, lastAttemptAt: iso(at(29, 20)), lastAttemptCode: "EMBED" });
  assert.equal(runs(s, at(29, 23)), false);
  assert.equal(runs(s, at(30, 11)), true);
});

test("attemptsToday ignores a counter left over from an earlier day", () => {
  assert.equal(attemptsToday(state({ day: "2026-10-19", attemptsToday: 1 }), at(24, 12)), 0);
  assert.equal(attemptsToday(state({ day: "2026-10-24", attemptsToday: 2 }), at(24, 12)), 2);
});

test("rollDay resets the per-day attempt counter", () => {
  const s = rollDay(state({ day: "2026-10-28", attemptsToday: 3 }), at(29, 10));
  assert.equal(s.day, "2026-10-29");
  assert.equal(s.attemptsToday, 0);
});

test("nextRunAt: after the 11:00 success → today 14:00; after 14:00 → tomorrow 11:00", () => {
  const morning = nextRunAt(state({ lastSuccessAt: iso(at(29, 11, 8)) }), config, at(29, 11, 30));
  assert.deepEqual([morning.getDate(), morning.getHours()], [29, 14]);
  const afternoon = nextRunAt(state({ lastSuccessAt: iso(at(29, 14, 9)) }), config, at(29, 15, 10));
  assert.deepEqual([afternoon.getDate(), afternoon.getHours()], [30, 11]);
});

test("launchd ticks: every hour + off-the-hour slots", () => {
  assert.equal(tickMinutes(config).length, 24);
  const ticks = tickMinutes({ slots: ["11:30", "14:00"] });
  assert.equal(ticks.length, 25);
  assert.ok(ticks.includes(11 * 60 + 30));
});

test("legacy single-slot config ({ hour, minute }) still schedules once a day", () => {
  const legacy = { hour: 14, minute: 0, maxAttemptsPerDay: 4, retryHours: 2 };
  const s = state({ lastSuccessAt: iso(at(28, 14, 5)) });
  assert.equal(shouldRun(s, legacy, at(29, 11)).run, false);
  assert.equal(shouldRun(s, legacy, at(29, 14)).run, true);
});

test("malformed slots are rejected", () => {
  assert.throws(() => parseSlots(["25:00"]));
  assert.throws(() => parseSlots(["11"]));
  assert.throws(() => parseSlots([]));
  assert.deepEqual(parseSlots(["14:00", "11:00", "14:00"]), [660, 840]);
});

// ---------------------------------------------------------------- publish decision

test("upload when nothing was ever published", () => {
  assert.equal(shouldUpload("abc", state()), true);
});

test("upload is retried after a failed publish (local != last published)", () => {
  // The old logic compared against the run's own START, so a failed upload followed by a no-change
  // run was never re-published. Comparing against lastUploaded fixes that.
  assert.equal(shouldUpload("new", state({ lastUploaded: { fingerprint: "old" } })), true);
});

test("no upload when the live data already matches", () => {
  assert.equal(shouldUpload("same", state({ lastUploaded: { fingerprint: "same" } })), false);
  assert.equal(shouldUpload("same", state({ lastUploaded: { fingerprint: "same" } }), true), true);
});

// ---------------------------------------------------------------- error classification (real failures)

const cases = [
  ['preflight: X auth (xrelay whoami) failed (exit 1):     "message": "not logged in" |   } | }', "X_AUTH", false],
  ["sync-bge (embed new posts + rebuild search artifacts) failed (exit 1): [sync-bge] FAILED: wrangler dev exited early (code 1, signal null) before reporting ready", "EMBED", true],
  ["upload-r2 (publish to prod) failed (exit 1):  | Creating object \"search-index-bge.bin\" in bucket", "UPLOAD", true],
  ["offline — network unreachable (api.cloudflare.com: ENOTFOUND, x.com: ENOTFOUND)", "OFFLINE", true],
  ["Cloudflare rejected the token (HTTP 401)", "CF_AUTH", false],
  ["archive shrank 7207 → 120 after the pull — restored the backup, nothing uploaded", "TRUNCATED", false],
  ["low disk: only 300 MB free (need 1 GB)", "DISK", false],
  ["sync-bge failed: Workers AI 429 (3040: Capacity temporarily exceeded)", "AI_RATE_LIMIT", true],
  ["something nobody anticipated", "UNKNOWN", true],
];
for (const [message, code, retryable] of cases) {
  test(`classify → ${code}: ${message.slice(0, 48)}…`, () => {
    const info = classifyError(message);
    assert.equal(info.code, code);
    assert.equal(info.retryable, retryable);
    assert.ok(info.hint.length > 10, "has an actionable hint");
  });
}

test("an offline symptom inside a step failure still classifies as OFFLINE", () => {
  assert.equal(classifyError("preflight: X auth (xrelay whoami) failed (exit 1): getaddrinfo ENOTFOUND x.com").code, "OFFLINE");
});

// ---------------------------------------------------------------- lock + history

const dir = mkdtempSync(join(tmpdir(), "autosync-test-"));
try {
  test("lock: first acquire wins, second is refused while the holder is alive", () => {
    const path = join(dir, "a.lock");
    assert.equal(acquireLock(path).ok, true);
    const second = acquireLock(path);
    assert.equal(second.ok, false);
    assert.equal(second.holder.pid, process.pid);
    releaseLock(path);
    assert.equal(existsSync(path), false);
  });

  test("lock: a dead holder's lock is stale and replaced", () => {
    const path = join(dir, "b.lock");
    writeFileSync(path, JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString() }));
    assert.equal(acquireLock(path).ok, true);
    releaseLock(path);
  });

  test("lock: an alive pid older than 3h is treated as reused (stale)", () => {
    const path = join(dir, "c.lock");
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 4 * 3_600_000).toISOString() }));
    assert.equal(acquireLock(path).ok, true);
    releaseLock(path);
  });

  test("lock: legacy plain-pid lock files are understood", () => {
    const path = join(dir, "d.lock");
    writeFileSync(path, "999999");
    assert.equal(acquireLock(path).ok, true);
    releaseLock(path);
  });

  test("runs.jsonl keeps only the newest N runs, newest first on read", () => {
    const path = join(dir, "runs.jsonl");
    for (let i = 0; i < 70; i += 1) appendRun(path, { i }, 60);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 60);
    assert.equal(readRuns(path, 1)[0].i, 69);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
