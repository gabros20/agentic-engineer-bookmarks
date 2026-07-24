// T2 integration verification (throwaway). Drives the REAL HTTP routes against
// a running Next dev server + the live dev DB, and asserts DB state directly.
//
// Prereqs: dev server running with MAGIC_LINK_SINK set to SINK_FILE below, e.g.
//   MAGIC_LINK_SINK=<abs sink> npm run dev
//
// Run:  node scripts/_t2-verify.mjs
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

const BASE = process.env.T2_BASE_URL ?? "http://localhost:3000";
const SINK = process.env.MAGIC_LINK_SINK ?? "/tmp/t2-magic-sink.jsonl";
const SECRET = process.env.DIGEST_UNLOCK_SECRET;
const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);

const INVITED = `t2-invited-${Date.now()}@example.com`;
const NONINV = `t2-noninvited-${Date.now()}@example.com`;

let pass = 0;
let fail = 0;
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

async function requestMagicLink(email) {
  // Send Origin to satisfy Better Auth's CSRF/origin check — a real browser
  // always sends this same-origin; node fetch omits it (would 403).
  const res = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email }),
  });
  return res;
}

async function completeMagicLink(url) {
  // GET the verify URL without following redirects; success → 302 to callback
  // with a Set-Cookie session; gate failure → redirect carrying an error.
  const res = await fetch(url, { method: "GET", redirect: "manual", headers: { origin: BASE } });
  return res;
}

async function cleanup() {
  await sql`delete from "user" where email in (${INVITED}, ${NONINV})`;
  await sql`delete from pending_signups where email in (${INVITED}, ${NONINV})`;
}

async function main() {
  writeFileSync(SINK, ""); // reset sink
  await cleanup();

  // --- Trigger seed via a verify call with the seed code, then Test 1 ---
  await fetch(`${BASE}/api/invite/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: SECRET, email: INVITED }),
  });
  const seedRows = await sql`select code, active from invite_codes where code = ${SECRET}`;
  check(
    "1 seed present (DIGEST_UNLOCK_SECRET active)",
    seedRows.length === 1 && seedRows[0].active === true,
    `rows=${seedRows.length} active=${seedRows[0]?.active}`,
  );

  // --- Test 2: invite/verify happy path (already called above) ---
  const p2 = await sql`select email, "expiresAt", "createdAt" from pending_signups where email = ${INVITED}`;
  let okExpiry = false;
  if (p2.length === 1) {
    const ttl = new Date(p2[0].expiresAt).getTime() - new Date(p2[0].createdAt).getTime();
    okExpiry = ttl > 14 * 60 * 1000 && ttl < 16 * 60 * 1000; // ~15 min
  }
  check("2 invite/verify happy path (pending row, ~15m ttl)", p2.length === 1 && okExpiry,
    `rows=${p2.length} ttlOk=${okExpiry}`);

  // --- Test 3: invite/verify rejection (bogus code) ---
  const badEmail = `t2-bogus-${Date.now()}@example.com`;
  const r3 = await fetch(`${BASE}/api/invite/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "definitely-not-a-real-code", email: badEmail }),
  });
  const p3 = await sql`select 1 from pending_signups where email = ${badEmail}`;
  check("3 invite/verify rejection (400, no pending row)", r3.status === 400 && p3.length === 0,
    `status=${r3.status} pending=${p3.length}`);

  // --- Test 4: invited sign-up succeeds ---
  const usedBefore = Number(
    (await sql`select "usedCount" from invite_codes where code = ${SECRET}`)[0].usedCount,
  );
  const req4 = await requestMagicLink(INVITED);
  const url4 = readSinkFor(INVITED);
  let ok4 = false, detail4 = `req=${req4.status}`;
  if (url4) {
    const v4 = await completeMagicLink(url4);
    const users = await sql`select id from "user" where email = ${INVITED}`;
    const sessions = users.length
      ? await sql`select id from session where "userId" = ${users[0].id}`
      : [];
    const pendingGone = (await sql`select 1 from pending_signups where email = ${INVITED}`).length === 0;
    const usedAfter = Number(
      (await sql`select "usedCount" from invite_codes where code = ${SECRET}`)[0].usedCount,
    );
    ok4 = users.length === 1 && sessions.length >= 1 && pendingGone && usedAfter === usedBefore + 1;
    detail4 = `verify=${v4.status} user=${users.length} session=${sessions.length} pendingGone=${pendingGone} used=${usedBefore}->${usedAfter}`;
  }
  check("4 invited sign-up succeeds (user+session, consumed, usedCount+1)", ok4, detail4);

  // --- Test 5: non-invited sign-up blocked ---
  const req5 = await requestMagicLink(NONINV);
  const url5 = readSinkFor(NONINV);
  let ok5 = false, detail5 = `req=${req5.status}`;
  if (url5) {
    const v5 = await completeMagicLink(url5);
    const users = await sql`select id from "user" where email = ${NONINV}`;
    ok5 = users.length === 0; // THE security assertion: no user, no session
    const loc = v5.headers.get("location") ?? "";
    detail5 = `verify=${v5.status} user=${users.length} loc=${loc.includes("error") ? "error" : loc ? "redirect" : "none"}`;
  }
  check("5 non-invited sign-up BLOCKED (no user row created)", ok5, detail5);

  // --- Test 6: returning login needs no code ---
  // INVITED user now exists; no new pending_signup. A fresh magic link must work.
  const before6 = INVITED
    ? (await sql`select count(*)::int as n from session s join "user" u on u.id = s."userId" where u.email = ${INVITED}`)[0].n
    : 0;
  const req6 = await requestMagicLink(INVITED);
  const url6 = readSinkFor(INVITED);
  let ok6 = false, detail6 = `req=${req6.status}`;
  if (url6) {
    const v6 = await completeMagicLink(url6);
    const after6 = (await sql`select count(*)::int as n from session s join "user" u on u.id = s."userId" where u.email = ${INVITED}`)[0].n;
    const users = await sql`select count(*)::int as n from "user" where email = ${INVITED}`;
    ok6 = after6 > before6 && users[0].n === 1;
    detail6 = `verify=${v6.status} sessions=${before6}->${after6} users=${users[0].n}`;
  }
  check("6 returning login needs no code (new session, no error)", ok6, detail6);

  // --- Report ---
  console.log("\n=== T2 verification ===");
  for (const r of results) console.log(r);
  console.log(`\n${pass} passed, ${fail} failed`);

  // Cleanup test rows; restore usedCount delta from test 4 so the seed count is untouched.
  await cleanup();
  await sql`update invite_codes set "usedCount" = ${usedBefore} where code = ${SECRET}`;
  console.log("cleaned up test rows; restored seed usedCount to", usedBefore);

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify script error:", e);
  process.exit(2);
});
