// T4 search-proxy verification (throwaway). Drives the REAL /api/search route against a running
// Next dev server (started with MAGIC_LINK_SINK) + the live dev DB + the local Worker (:8787).
// Proves: unauth /api/search → 401; authed → 200 { results }; empty query → 200 [] WITHOUT
// counting quota; per-user 300/day cap → 429 { code: "search_quota" } on the 301st search.
//
// Prereqs:  local Worker on :8787 (wrangler dev) + data server :8080
//           MAGIC_LINK_SINK=<file> npm run dev   (dev, so the magic-link sink is active)
// Run:      MAGIC_LINK_SINK=<file> node scripts/_t4-verify.mjs
//
import { readFileSync, writeFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

function loadEnvLocal() {
  const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (process.env[k] === undefined) process.env[k] = v.replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

const BASE = process.env.T4_BASE_URL ?? "http://localhost:3000";
const SINK = process.env.MAGIC_LINK_SINK ?? "/tmp/t4-magic-sink.jsonl";
const INVITE = process.env.DIGEST_UNLOCK_SECRET; // the seed invite code (see _t3-verify)
const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
const DAY = new Date().toISOString().slice(0, 10); // UTC day — MUST match app/api/search/route.ts

const USER = `t4-user-${Date.now()}@example.com`;

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (ok) pass++; else fail++;
}

function readSinkFor(email) {
  const lines = readFileSync(SINK, "utf8").trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = JSON.parse(lines[i]);
    if (rec.email === email) return rec.url;
  }
  return null;
}
function cookiesFromSetCookie(res) {
  const jar = [];
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0];
    if (/Max-Age=0/i.test(c) || pair.endsWith("=")) continue;
    const name = pair.split("=")[0];
    if (name.includes("session") || name.includes("better-auth")) jar.push(pair);
  }
  return jar.join("; ");
}
async function apiSearch(cookie, body) {
  const res = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
async function userId() {
  const rows = await sql`select id from "user" where email = ${USER}`;
  return rows[0]?.id ?? null;
}
async function searchCount(uid) {
  const rows = await sql`select "searchCount" from ai_usage_daily where "userId" = ${uid} and day = ${DAY}`;
  return rows[0]?.searchCount ?? null;
}

async function main() {
  writeFileSync(SINK, "");
  await sql`delete from "user" where email = ${USER}`;
  await sql`delete from pending_signups where email = ${USER}`;

  // --- P4a. Unauthenticated /api/search → 401 (no session) ---
  const unauth = await apiSearch(null, { query: "ai agents", precision: "broad" });
  check("P4a unauth /api/search → 401", unauth.status === 401, `status=${unauth.status} body=${JSON.stringify(unauth.json)}`);

  // --- Log in (captured magic-link token) → session cookie ---
  await fetch(`${BASE}/api/invite/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: INVITE, email: USER }),
  });
  await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: USER, callbackURL: "/" }),
  });
  const url = readSinkFor(USER);
  const v = await fetch(url, { method: "GET", redirect: "manual", headers: { origin: BASE } });
  const cookie = cookiesFromSetCookie(v);
  const uid = await userId();
  if (!cookie || !uid) {
    check("login prerequisite", false, `cookie=${cookie ? "set" : "none"} uid=${uid}`);
    return finish();
  }

  // --- P4b. Authed /api/search → 200 { results:[...] } (same shape as the Worker) ---
  const authed = await apiSearch(cookie, { query: "ai agents", precision: "broad" });
  const okShape = authed.status === 200 && Array.isArray(authed.json?.results) && authed.json.results.length > 0
    && typeof authed.json.results[0].id === "string" && typeof authed.json.results[0].score === "number";
  check("P4b authed /api/search → 200 { results:[{id,score}] }", okShape,
    `status=${authed.status} n=${authed.json?.results?.length} phase=${authed.json?.phase}`);
  const afterOne = await searchCount(uid);
  check("P4b real search incremented quota to 1", afterOne === 1, `searchCount=${afterOne}`);

  // --- P4c. Empty/whitespace query → 200 { results:[] } and does NOT increment quota ---
  const empty = await apiSearch(cookie, { query: "   ", precision: "broad" });
  const emptyCount = await searchCount(uid);
  check("P4c empty query → 200 [] and quota UNCHANGED", empty.status === 200
    && Array.isArray(empty.json?.results) && empty.json.results.length === 0 && emptyCount === 1,
    `status=${empty.status} results=${JSON.stringify(empty.json?.results)} searchCount=${emptyCount}`);

  // --- P5. Quota cap: drive today's count to 300, then the 301st search → 429 search_quota ---
  await sql`update ai_usage_daily set "searchCount" = 300 where "userId" = ${uid} and day = ${DAY}`;
  const blocked = await apiSearch(cookie, { query: "ai agents", precision: "broad" });
  const okBlocked = blocked.status === 429 && blocked.json?.code === "search_quota";
  const countAfterBlock = await searchCount(uid);
  check("P5 301st search → 429 { code: search_quota }", okBlocked,
    `status=${blocked.status} code=${blocked.json?.code} searchCount=${countAfterBlock}`);

  // --- P5b. Empty query still does NOT count even at the cap (stays 301, not forwarded) ---
  const emptyAtCap = await apiSearch(cookie, { query: "", precision: "broad" });
  const countAfterEmpty = await searchCount(uid);
  check("P5b empty query at cap → 200 [] and quota UNCHANGED", emptyAtCap.status === 200
    && countAfterEmpty === countAfterBlock, `status=${emptyAtCap.status} searchCount=${countAfterEmpty}`);

  finish();
}

function finish() {
  console.log("\n=== T4 verification ===");
  for (const r of results) console.log(r);
  console.log(`\n${pass} passed, ${fail} failed`);
  // Cleanup: delete the test user (ai_usage_daily + sessions cascade via FK).
  sql`delete from "user" where email = ${USER}`
    .then(() => sql`delete from pending_signups where email = ${USER}`)
    .then(() => { console.log("cleaned up test user", USER); process.exit(fail === 0 ? 0 : 1); })
    .catch((e) => { console.error("cleanup error:", e); process.exit(2); });
}

main().catch((e) => { console.error("verify error:", e); process.exit(2); });
