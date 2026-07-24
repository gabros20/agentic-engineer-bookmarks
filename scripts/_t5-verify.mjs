// T5 AI-gating verification (throwaway). Drives the REAL /api/digest, /api/chat, /api/expand
// routes against a running Next dev server (started with MAGIC_LINK_SINK) + the live dev DB.
// Proves: unauth all three → 401; authed digest streams AND persists a saved_digests row (EN+HU);
// persistence survives a mid-stream client abort (tee + after); digest 11th → 429 digest_quota;
// chat 41st → 429 chat_quota; authed chat turn streams; authed expand → 200 rewrites.
//
// Note: /api/digest takes `sources` in the body (the client does the Worker re-query, not the
// route) and chat's search tool runs client-side — so NO local Worker is needed here.
//
// Prereqs:  MAGIC_LINK_SINK=<file> npm run dev   (dev, so the magic-link sink is active)
// Run:      MAGIC_LINK_SINK=<file> node scripts/_t5-verify.mjs
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

const BASE = process.env.T5_BASE_URL ?? "http://localhost:3000";
const SINK = process.env.MAGIC_LINK_SINK ?? "/tmp/t5-magic-sink.jsonl";
const INVITE = process.env.DIGEST_UNLOCK_SECRET; // the seed invite code (now ONLY an invite seed)
const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
const DAY = new Date().toISOString().slice(0, 10); // UTC day — MUST match the routes

const USER = `t5-user-${Date.now()}@example.com`;
const STAMP = Date.now();

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

const SOURCES = [
  { id: "111", author: "Ada L", screenName: "ada", text: "Agentic coding loops with tool use are eating dev workflows.", url: "https://x.com/ada/status/111" },
  { id: "222", author: "Grace H", screenName: "grace", text: "Retrieval + rerank beats raw vector search for small archives.", url: "https://x.com/grace/status/222" },
  { id: "333", author: "Alan T", screenName: "alan", text: "Structured output via schema-constrained decoding is now reliable.", url: "https://x.com/alan/status/333" },
];

async function post(path, cookie, body, signal) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    signal,
  });
}
async function userId() {
  const rows = await sql`select id from "user" where email = ${USER}`;
  return rows[0]?.id ?? null;
}
async function digestRows(uid, q) {
  return sql`select id, title, query, precision, content, "sourceIds", language from saved_digests where "userId" = ${uid} and query = ${q}`;
}
async function counts(uid) {
  const rows = await sql`select "digestCount", "chatCount" from ai_usage_daily where "userId" = ${uid} and day = ${DAY}`;
  return { digestCount: rows[0]?.digestCount ?? null, chatCount: rows[0]?.chatCount ?? null };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  writeFileSync(SINK, "");
  await sql`delete from "user" where email = ${USER}`;
  await sql`delete from pending_signups where email = ${USER}`;

  // --- P2. Unauthenticated → 401 on all three routes ---
  for (const [path, body] of [
    ["/api/digest", { query: "x", sources: SOURCES, language: "en" }],
    ["/api/chat", { messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }], context: { language: "en" } }],
    ["/api/expand", { query: "ai agents", language: "en" }],
  ]) {
    const res = await post(path, null, body);
    const j = await res.json().catch(() => null);
    check(`P2 unauth ${path} → 401`, res.status === 401, `status=${res.status} body=${JSON.stringify(j)}`);
  }

  // --- Log in (captured magic-link token) → session cookie ---
  await post("/api/invite/verify", null, { code: INVITE, email: USER });
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

  // --- P4. Authed digest EN → streams a valid digest AND persists a saved_digests row ---
  const qEN = `T5 EN digest ${STAMP}`;
  const rEN = await post("/api/digest", cookie, { query: qEN, sources: SOURCES, language: "en" });
  const bodyEN = await rEN.text(); // read the text/plain stream to completion
  let parsedEN = null; try { parsedEN = JSON.parse(bodyEN); } catch {}
  const streamedEN = rEN.status === 200 && parsedEN && Array.isArray(parsedEN.themes) && typeof parsedEN.overall === "string";
  await sleep(1500); // let after()/onFinish settle the DB write
  const rowsEN = await digestRows(uid, qEN);
  const rEnRow = rowsEN[0];
  const persistEN = rowsEN.length === 1 && rEnRow.language === "en" && rEnRow.query === qEN
    && rEnRow.title === qEN && rEnRow.precision === null
    && Array.isArray(rEnRow.sourceIds) && rEnRow.sourceIds.join(",") === "111,222,333"
    && rEnRow.content && Array.isArray(rEnRow.content.themes);
  check("P4 authed digest EN streams valid object", streamedEN, `status=${rEN.status} keys=${parsedEN ? Object.keys(parsedEN).join("|") : "none"}`);
  check("P4 digest EN persisted saved_digests row (lang/query/title/precision/sourceIds/content)", persistEN,
    `rows=${rowsEN.length} lang=${rEnRow?.language} sourceIds=${JSON.stringify(rEnRow?.sourceIds)} contentThemes=${rEnRow?.content?.themes?.length}`);

  // --- P4(HU). Authed digest HU → persists with language "hu" ---
  const qHU = `T5 HU digest ${STAMP}`;
  const rHU = await post("/api/digest", cookie, { query: qHU, sources: SOURCES, language: "hu" });
  await rHU.text();
  await sleep(1500);
  const rowsHU = await digestRows(uid, qHU);
  check("P4 authed digest HU persisted saved_digests row (language=hu)",
    rowsHU.length === 1 && rowsHU[0].language === "hu" && Array.isArray(rowsHU[0].content?.themes),
    `status=${rHU.status} rows=${rowsHU.length} lang=${rowsHU[0]?.language}`);

  // --- P5. Persistence-on-disconnect: abort the client mid-stream, row STILL written ---
  const qAB = `T5 ABORT digest ${STAMP}`;
  const ac = new AbortController();
  let abortedDuringStream = false;
  try {
    const rAB = await post("/api/digest", cookie, { query: qAB, sources: SOURCES, language: "en" }, ac.signal);
    const reader = rAB.body.getReader();
    // Read the FIRST chunk (proves streaming started), then abort — simulating a closed tab.
    await reader.read();
    ac.abort();
    abortedDuringStream = true;
    try { await reader.read(); } catch {}
  } catch (e) {
    // fetch itself may throw AbortError after abort(); that's the disconnect we're simulating.
    abortedDuringStream = true;
  }
  // Poll for the row for up to ~40s: after() drives generation to completion server-side.
  let abRow = null;
  for (let i = 0; i < 40; i++) {
    const rows = await digestRows(uid, qAB);
    if (rows.length >= 1) { abRow = rows[0]; break; }
    await sleep(1000);
  }
  check("P5 digest persisted AFTER mid-stream client abort (tee + after)",
    Boolean(abRow) && abRow.language === "en" && Array.isArray(abRow.content?.themes),
    `abortedDuringStream=${abortedDuringStream} row=${abRow ? "written" : "MISSING"} themes=${abRow?.content?.themes?.length}`);

  // --- P7. Authed chat turn → 200, streams a UI-message response ---
  const rChat = await post("/api/chat", cookie, {
    messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "In one short sentence, what is this archive about?" }] }],
    context: { language: "en", query: null, precision: null, sources: [], digest: null, archiveCount: 4600 },
  });
  const chatBody = await rChat.text();
  check("P7 authed chat turn → 200 streamed response", rChat.status === 200 && chatBody.length > 0,
    `status=${rChat.status} bytes=${chatBody.length}`);

  // --- P7b. Authed expand → 200 { rewrites: [...] } ---
  const rExp = await post("/api/expand", cookie, { query: "ágensek", language: "en" });
  const expJson = await rExp.json().catch(() => null);
  check("P7b authed expand → 200 { rewrites }", rExp.status === 200 && Array.isArray(expJson?.rewrites),
    `status=${rExp.status} rewrites=${JSON.stringify(expJson?.rewrites)}`);

  // --- P6. Digest quota: force digestCount=10, then the 11th → 429 digest_quota ---
  await sql`update ai_usage_daily set "digestCount" = 10 where "userId" = ${uid} and day = ${DAY}`;
  const dBlocked = await post("/api/digest", cookie, { query: `T5 over ${STAMP}`, sources: SOURCES, language: "en" });
  const dBlockedJson = await dBlocked.json().catch(() => null);
  check("P6 11th digest → 429 { code: digest_quota }",
    dBlocked.status === 429 && dBlockedJson?.code === "digest_quota",
    `status=${dBlocked.status} code=${dBlockedJson?.code}`);

  // --- P6b. Chat quota: force chatCount=40, then the 41st → 429 chat_quota ---
  await sql`update ai_usage_daily set "chatCount" = 40 where "userId" = ${uid} and day = ${DAY}`;
  const cBlocked = await post("/api/chat", cookie, {
    messages: [{ id: "u2", role: "user", parts: [{ type: "text", text: "hi" }] }],
    context: { language: "en" },
  });
  const cBlockedJson = await cBlocked.json().catch(() => null);
  check("P6b 41st chat → 429 { code: chat_quota }",
    cBlocked.status === 429 && cBlockedJson?.code === "chat_quota",
    `status=${cBlocked.status} code=${cBlockedJson?.code}`);

  const finalCounts = await counts(uid);
  results.push(`INFO  final counts before cleanup: ${JSON.stringify(finalCounts)}`);

  finish();
}

function finish() {
  console.log("\n=== T5 verification ===");
  for (const r of results) console.log(r);
  console.log(`\n${pass} passed, ${fail} failed`);
  // Cleanup: delete the test user (saved_digests + ai_usage_daily + sessions cascade via FK).
  sql`delete from "user" where email = ${USER}`
    .then(() => sql`delete from pending_signups where email = ${USER}`)
    .then(() => { console.log("cleaned up test user", USER); process.exit(fail === 0 ? 0 : 1); })
    .catch((e) => { console.error("cleanup error:", e); process.exit(2); });
}

main().catch((e) => { console.error("verify error:", e); process.exit(2); });
