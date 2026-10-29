// Unit tests for the sync autopilot's decision logic (scheduling, error classification, lock,
// publish decision). Plain node:assert, no framework (matches scripts/test-search-core.mjs).
// Run via `npm run test:autosync`.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classifyError } from "./lib/sync-errors.mjs";
import { EMPTY_STATE, acquireLock, appendRun, nextRunAt, readRuns, releaseLock, rollDay, shouldRun, shouldUpload } from "./lib/sync-state.mjs";

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

const config = { hour: 14, minute: 0, maxAttemptsPerDay: 4, retryHours: 2 };
const at = (day, hh, mm = 0) => new Date(2026, 9, day, hh, mm); // local time, Oct 2026
const state = (patch = {}) => ({ ...structuredClone(EMPTY_STATE), ...patch });
const iso = (d) => d.toISOString();

// ---------------------------------------------------------------- scheduling

test("before the daily slot, with yesterday's success → skip", () => {
  const s = state({ lastSuccessAt: iso(at(28, 14, 5)) });
  assert.equal(shouldRun(s, config, at(29, 9)).run, false);
});

test("at/after the daily slot, not yet synced today → run", () => {
  const s = state({ lastSuccessAt: iso(at(28, 14, 5)) });
  assert.equal(shouldRun(s, config, at(29, 14)).run, true);
  assert.equal(shouldRun(s, config, at(29, 21)).run, true);
});

test("already synced today → skip for the rest of the day", () => {
  const s = state({ lastSuccessAt: iso(at(29, 14, 3)) });
  assert.equal(shouldRun(s, config, at(29, 15)).run, false);
  assert.equal(shouldRun(s, config, at(29, 23)).run, false);
});

test("missed day (last success > 26h ago) → catch up even before the slot", () => {
  const s = state({ lastSuccessAt: iso(at(27, 14, 5)) });
  const decision = shouldRun(s, config, at(29, 8));
  assert.equal(decision.run, true);
  assert.match(decision.reason, /catching up/);
});

test("never synced → run immediately", () => {
  assert.equal(shouldRun(state(), config, at(29, 3)).run, true);
});

test("failed attempt → wait retryHours before the next one", () => {
  const s = state({ lastSuccessAt: iso(at(28, 14)), day: "2026-10-29", attemptsToday: 1, lastAttemptAt: iso(at(29, 14)), lastAttemptCode: "EMBED" });
  assert.equal(shouldRun(s, config, at(29, 15)).run, false);
  assert.equal(shouldRun(s, config, at(29, 16)).run, true);
});

test("offline attempt → retry on the next hourly tick", () => {
  const s = state({ lastSuccessAt: iso(at(28, 14)), day: "2026-10-29", attemptsToday: 0, lastAttemptAt: iso(at(29, 14)), lastAttemptCode: "OFFLINE" });
  assert.equal(shouldRun(s, config, at(29, 15)).run, true);
});

test("attempt cap → give up for the day, fresh budget tomorrow", () => {
  const s = state({ lastSuccessAt: iso(at(28, 14)), day: "2026-10-29", attemptsToday: 4, lastAttemptAt: iso(at(29, 20)), lastAttemptCode: "EMBED" });
  assert.equal(shouldRun(s, config, at(29, 23)).run, false);
  // Next day: the counter belongs to the 29th, so it doesn't apply on the 30th (after the 2h spacing).
  assert.equal(shouldRun(s, config, at(30, 14)).run, true);
});

test("rollDay resets the per-day attempt counter", () => {
  const s = rollDay(state({ day: "2026-10-28", attemptsToday: 3 }), at(29, 10));
  assert.equal(s.day, "2026-10-29");
  assert.equal(s.attemptsToday, 0);
});

test("nextRunAt: after today's success → tomorrow at the slot", () => {
  const s = state({ lastSuccessAt: iso(at(29, 14, 2)) });
  const next = nextRunAt(s, config, at(29, 15, 10));
  assert.equal(next.getDate(), 30);
  assert.equal(next.getHours(), 14);
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
