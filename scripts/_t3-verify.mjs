// T3 login-wall verification (throwaway). Drives the REAL HTTP routes against a
// running Next dev server (started with MAGIC_LINK_SINK) + the live dev DB.
// Proves: unauth redirect, allow-list reachability, full captured-token login
// yielding a session that renders the app, and sign-out revoking it.
//
// Prereqs:  MAGIC_LINK_SINK=<file> npm run dev   (dev, so the sink is active)
// Run:      MAGIC_LINK_SINK=<file> node scripts/_t3-verify.mjs
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

const BASE = process.env.T3_BASE_URL ?? "http://localhost:3000";
const SINK = process.env.MAGIC_LINK_SINK ?? "/tmp/t3-magic-sink.jsonl";
const SECRET = process.env.DIGEST_UNLOCK_SECRET;
const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);

const USER = `t3-user-${Date.now()}@example.com`;

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

// Extract the better-auth session cookie name=value pairs from Set-Cookie.
function cookiesFromSetCookie(res) {
  const jar = [];
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0];
    const name = pair.split("=")[0];
    // Skip explicit deletions (empty value / Max-Age=0).
    if (/Max-Age=0/i.test(c) || pair.endsWith("=")) continue;
    if (name.includes("session") || name.includes("better-auth")) jar.push(pair);
  }
  return jar.join("; ");
}

async function main() {
  writeFileSync(SINK, "");
  await sql`delete from "user" where email = ${USER}`;
  await sql`delete from pending_signups where email = ${USER}`;

  // --- 2a. Unauthenticated GET / → 307 redirect to /login ---
  const r1 = await fetch(`${BASE}/`, { method: "GET", redirect: "manual" });
  check("2a unauth GET / redirects to /login",
    (r1.status === 307 || r1.status === 302) && (r1.headers.get("location") ?? "").endsWith("/login"),
    `status=${r1.status} loc=${r1.headers.get("location")}`);

  // --- 2b. GET /login → 200 ---
  const r2 = await fetch(`${BASE}/login`, { method: "GET", redirect: "manual" });
  const loginHtml = await r2.text();
  check("2b GET /login → 200", r2.status === 200, `status=${r2.status}`);

  // --- 3. allow-list: /api/invite/* and /api/auth/* reachable (NOT redirected) ---
  const rInvite = await fetch(`${BASE}/api/invite/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: SECRET, email: USER }),
  });
  const inviteJson = await rInvite.json().catch(() => null);
  const inviteReachable = rInvite.status === 200 && inviteJson?.ok === true;
  const rAuth = await fetch(`${BASE}/api/auth/get-session`, { method: "GET", redirect: "manual" });
  // Not redirected to /login (proxy let it through); 200 with null body when no session.
  const authReachable = rAuth.status !== 307 && rAuth.status !== 302;
  check("3 /api/invite/* and /api/auth/* reachable without session", inviteReachable && authReachable,
    `invite=${rInvite.status} ok=${inviteJson?.ok} auth=${rAuth.status}`);

  // --- 4. Full login via captured token → session cookie → GET / renders app ---
  await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: USER, callbackURL: "/" }),
  });
  const url = readSinkFor(USER);
  let ok4 = false, detail4 = "no magic url captured";
  let cookie = "";
  if (url) {
    const v = await fetch(url, { method: "GET", redirect: "manual", headers: { origin: BASE } });
    cookie = cookiesFromSetCookie(v);
    const gated = await fetch(`${BASE}/`, {
      method: "GET", redirect: "manual", headers: { cookie },
    });
    const body = gated.status === 200 ? await gated.text() : "";
    const renders = gated.status === 200 && body.includes("X Bookmarks");
    const users = await sql`select id from "user" where email = ${USER}`;
    ok4 = v.status >= 300 && v.status < 400 && !!cookie && renders && users.length === 1;
    detail4 = `verify=${v.status} cookie=${cookie ? "set" : "none"} gated=${gated.status} appShell=${renders} user=${users.length}`;
  }
  check("4 captured-token login → session renders app shell", ok4, detail4);

  // --- 5. Sign-out revokes the session (subsequent / with old cookie → /login) ---
  let ok5 = false, detail5 = "skipped (no cookie)";
  if (cookie) {
    const so = await fetch(`${BASE}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin: BASE, cookie, "content-type": "application/json" },
      body: "{}",
    });
    const after = await fetch(`${BASE}/`, { method: "GET", redirect: "manual", headers: { cookie } });
    const redirected = (after.status === 307 || after.status === 302) &&
      (after.headers.get("location") ?? "").endsWith("/login");
    ok5 = so.status === 200 && redirected;
    detail5 = `signout=${so.status} thenGET/=${after.status} loc=${after.headers.get("location")}`;
  }
  check("5 sign-out revokes session (old cookie → /login)", ok5, detail5);

  // --- 6. EN renders in SSR + the EN/HU language toggle is present so HU is
  // reachable client-side (a real HU render is confirmed via the browser check).
  const enOk = loginHtml.includes("Sign in") || loginHtml.includes("Send magic link");
  const toggleOk = loginHtml.includes("fi-hu") && loginHtml.includes("fi-gb");
  check("6 login renders EN + ships HU toggle", enOk && toggleOk, `en=${enOk} toggle=${toggleOk}`);

  console.log("\n=== T3 verification ===");
  for (const r of results) console.log(r);
  console.log(`\n${pass} passed, ${fail} failed`);

  // Cleanup: remove the test user + its sessions; restore seed usedCount.
  await sql`delete from "user" where email = ${USER}`; // sessions cascade via FK
  await sql`delete from pending_signups where email = ${USER}`;
  console.log("cleaned up test user", USER);

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("verify error:", e); process.exit(2); });
