// T6 cross-device-sync verification (throwaway). Drives the REAL /api/digests, /api/chats,
// /api/migrate routes against a running Next dev server + the live dev DB. No Worker/OpenRouter
// needed: a "generated" digest is simulated by inserting a saved_digests row exactly as
// /api/digest onFinish (T5) does, then read/deleted through the routes.
//
// Prereqs:  MAGIC_LINK_SINK=<file> npm run dev   (dev, so the magic-link sink is active)
// Run:      MAGIC_LINK_SINK=<file> node scripts/_t6-verify.mjs
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

const BASE = process.env.T6_BASE_URL ?? "http://localhost:3000";
const SINK = process.env.MAGIC_LINK_SINK ?? "/tmp/t6-magic-sink.jsonl";
const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);
const TS = Date.now();
const CODE = `t6-${TS}`;
const A = `t6-a-${TS}@example.com`;
const B = `t6-b-${TS}@example.com`;

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
async function login(email, withInvite) {
  if (withInvite) {
    await fetch(`${BASE}/api/invite/verify`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: CODE, email }),
    });
  }
  await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST", headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, callbackURL: "/" }),
  });
  const url = readSinkFor(email);
  const v = await fetch(url, { method: "GET", redirect: "manual", headers: { origin: BASE } });
  return cookiesFromSetCookie(v);
}
async function api(path, { method = "GET", cookie, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const uid = async (email) => (await sql`select id from "user" where email = ${email}`)[0]?.id ?? null;

function makeChat(id, msgs) {
  return {
    id,
    title: "test chat",
    language: "en",
    query: "ai agents",
    createdAt: new Date().toISOString(),
    messages: msgs,
  };
}
const msg = (id, role, text) => ({ id, role, parts: [{ type: "text", text }] });

async function main() {
  writeFileSync(SINK, "");
  await sql`delete from "user" where email in (${A}, ${B})`;
  await sql`delete from pending_signups where email in (${A}, ${B})`;
  await sql`delete from invite_codes where code = ${CODE}`;
  await sql`insert into invite_codes (id, code, "maxUses", "usedCount", active) values (${"ic-" + TS}, ${CODE}, 1000, 0, true)`;

  // ---- P2. Unauthenticated → 401 on every new route ----
  const unauth = [
    await api("/api/digests"),
    await api("/api/digests/x", { method: "DELETE" }),
    await api("/api/chats"),
    await api("/api/chats", { method: "POST", body: makeChat("c_x", []) }),
    await api("/api/chats/x"),
    await api("/api/chats/x", { method: "DELETE" }),
    await api("/api/migrate", { method: "POST", body: { digests: [], chats: [] } }),
  ];
  check("P2 all new routes 401 unauth", unauth.every((r) => r.status === 401),
    unauth.map((r) => r.status).join(","));

  // ---- Login: A (two independent sessions = two devices), B ----
  const aCookie1 = await login(A, true);
  const aCookie2 = await login(A, false); // returning user, fresh session = "second device"
  const bCookie = await login(B, true);
  const aId = await uid(A);
  const bId = await uid(B);
  if (!aCookie1 || !aCookie2 || !bCookie || !aId || !bId) {
    check("login prerequisite", false, `a1=${!!aCookie1} a2=${!!aCookie2} b=${!!bCookie} aId=${aId} bId=${bId}`);
    return finish();
  }
  check("cross-device precondition: A has two distinct session cookies", aCookie1 !== aCookie2);

  // ---- P3. As A: a "generated" digest (insert like T5 onFinish) + a saved chat (POST) ----
  const digestId = `dg-${TS}`;
  await sql`insert into saved_digests (id, "userId", title, query, content, "sourceIds", language)
            values (${digestId}, ${aId}, ${"ai agents"}, ${"ai agents"},
                    ${JSON.stringify({ tldr: "t", overall: "o", themes: [{ title: "T", summary: "s", sources: [] }], readFirst: [], deeperReads: [] })}::jsonb,
                    ${JSON.stringify(["s1", "s2", "s3"])}::jsonb, ${"en"})`;
  const chatId = `c_${TS}`;
  const saved = await api("/api/chats", { method: "POST", cookie: aCookie1,
    body: makeChat(chatId, [msg("m1", "user", "hello"), msg("m2", "assistant", "hi"), msg("m3", "user", "bye")]) });
  check("P3 POST /api/chats → ok", saved.status === 200 && saved.json?.id === chatId, `status=${saved.status}`);

  const dgRows = await sql`select id from saved_digests where "userId" = ${aId}`;
  const csRows = await sql`select id from chat_sessions where "userId" = ${aId}`;
  const cmRows = await sql`select id from chat_messages where "sessionId" = ${chatId}`;
  check("P3 Neon rows for A (digest, session, 3 messages)",
    dgRows.length === 1 && csRows.length === 1 && cmRows.length === 3,
    `digests=${dgRows.length} sessions=${csRows.length} messages=${cmRows.length}`);

  const aList1 = await api("/api/digests", { cookie: aCookie1 });
  const aChats1 = await api("/api/chats", { cookie: aCookie1 });
  check("P3 A lists its digest + chat from DB",
    aList1.json?.digests?.some((d) => d.id === digestId) && aList1.json.digests[0].sourceCount === 3
      && aChats1.json?.chats?.some((c) => c.id === chatId && c.query === "ai agents"),
    `digest.sourceCount=${aList1.json?.digests?.[0]?.sourceCount} chats=${aChats1.json?.chats?.length}`);

  // ---- P4. Cross-device: second A session sees the SAME lists; B sees NONE ----
  const aList2 = await api("/api/digests", { cookie: aCookie2 });
  const aChats2 = await api("/api/chats", { cookie: aCookie2 });
  check("P4 cross-device: A session #2 sees the same digest + chat",
    aList2.json?.digests?.some((d) => d.id === digestId) && aChats2.json?.chats?.some((c) => c.id === chatId));
  const bList = await api("/api/digests", { cookie: bCookie });
  const bChats = await api("/api/chats", { cookie: bCookie });
  check("P4 isolation: B sees NONE of A's data",
    (bList.json?.digests?.length ?? -1) === 0 && (bChats.json?.chats?.length ?? -1) === 0,
    `bDigests=${bList.json?.digests?.length} bChats=${bChats.json?.chats?.length}`);
  const bReadChat = await api(`/api/chats/${chatId}`, { cookie: bCookie });
  const bReadDigestQ = await api(`/api/digests?query=${encodeURIComponent("ai agents")}`, { cookie: bCookie });
  check("P4 isolation: B cannot read A's chat (404) nor A's digest via ?query= (null)",
    bReadChat.status === 404 && bReadDigestQ.json?.digest === null, `chat=${bReadChat.status}`);

  // ---- P5. Delete is user-scoped ----
  const bDelDigest = await api(`/api/digests/${digestId}`, { method: "DELETE", cookie: bCookie });
  const bDelChat = await api(`/api/chats/${chatId}`, { method: "DELETE", cookie: bCookie });
  const stillDg = await sql`select id from saved_digests where id = ${digestId}`;
  const stillCs = await sql`select id from chat_sessions where id = ${chatId}`;
  check("P5 B's cross-user delete rejected (404) + A's rows intact",
    bDelDigest.status === 404 && bDelChat.status === 404 && stillDg.length === 1 && stillCs.length === 1,
    `delDg=${bDelDigest.status} delChat=${bDelChat.status} dgLeft=${stillDg.length} csLeft=${stillCs.length}`);

  // ---- P6. Reopen: ordered messages ----
  const reopen = await api(`/api/chats/${chatId}`, { cookie: aCookie2 });
  const m = reopen.json?.chat?.messages ?? [];
  check("P6 reopen loads ordered messages verbatim",
    m.length === 3 && m[0].role === "user" && m[0].parts?.[0]?.text === "hello"
      && m[1].role === "assistant" && m[2].parts?.[0]?.text === "bye",
    `n=${m.length} roles=${m.map((x) => x.role).join("/")}`);

  // ---- P6b. Upsert by id: re-save grown conversation → updates, no duplicate ----
  await api("/api/chats", { method: "POST", cookie: aCookie1,
    body: makeChat(chatId, [msg("m1", "user", "hello"), msg("m2", "assistant", "hi"), msg("m3", "user", "bye"), msg("m4", "assistant", "cya")]) });
  const afterUpsertSessions = await sql`select id from chat_sessions where id = ${chatId}`;
  const afterUpsertMsgs = await sql`select id from chat_messages where "sessionId" = ${chatId}`;
  check("P6b re-save upserts (1 session, 4 messages, no dupes)",
    afterUpsertSessions.length === 1 && afterUpsertMsgs.length === 4,
    `sessions=${afterUpsertSessions.length} messages=${afterUpsertMsgs.length}`);

  // ---- P5b. A deletes its own → gone (messages cascade) ----
  const aDelDigest = await api(`/api/digests/${digestId}`, { method: "DELETE", cookie: aCookie1 });
  const aDelChat = await api(`/api/chats/${chatId}`, { method: "DELETE", cookie: aCookie1 });
  const goneDg = await sql`select id from saved_digests where id = ${digestId}`;
  const goneCs = await sql`select id from chat_sessions where id = ${chatId}`;
  const goneCm = await sql`select id from chat_messages where "sessionId" = ${chatId}`;
  check("P5b A deletes own digest+chat → gone from DB (messages cascade)",
    aDelDigest.status === 200 && aDelChat.status === 200 && goneDg.length === 0 && goneCs.length === 0 && goneCm.length === 0,
    `dg=${goneDg.length} cs=${goneCs.length} cm=${goneCm.length}`);

  // ---- P7. Migration: one-shot idempotent + non-destructive ----
  const legacyDigest = { query: "legacy topic", themes: [{ title: "L", summary: "s", sources: [] }], overall: "ov", tldr: "tl", readFirst: [], deeperReads: [], sourceCount: 7, createdAt: new Date(TS - 1000).toISOString() };
  const legacyChat = makeChat(`c_legacy_${TS}`, [msg("lm1", "user", "legacy q")]);
  const mig1 = await api("/api/migrate", { method: "POST", cookie: aCookie1, body: { digests: [legacyDigest], chats: [legacyChat] } });
  const mig2 = await api("/api/migrate", { method: "POST", cookie: aCookie1, body: { digests: [legacyDigest], chats: [legacyChat] } });
  const migDg = await sql`select content from saved_digests where "userId" = ${aId} and query = ${"legacy topic"}`;
  const migCs = await sql`select id from chat_sessions where id = ${legacyChat.id}`;
  check("P7 migration one-shot: 1st inserts, 2nd inserts nothing (idempotent)",
    mig1.json?.digestsInserted === 1 && mig1.json?.chatsInserted === 1
      && mig2.json?.digestsInserted === 0 && mig2.json?.chatsInserted === 0
      && migDg.length === 1 && migCs.length === 1,
    `1=${JSON.stringify(mig1.json)} 2=${JSON.stringify(mig2.json)} dgRows=${migDg.length}`);
  check("P7 migrated legacy digest recovers sourceCount from content",
    migDg[0]?.content?.sourceCount === 7, `sourceCount=${migDg[0]?.content?.sourceCount}`);
  const migList = await api("/api/digests", { cookie: aCookie2 });
  check("P7 migrated digest lists with sourceCount 7 (cross-device)",
    migList.json?.digests?.some((d) => d.query === "legacy topic" && d.sourceCount === 7));

  finish();
}
async function cleanup() {
  await sql`delete from "user" where email in (${A}, ${B})`;
  await sql`delete from pending_signups where email in (${A}, ${B})`;
  await sql`delete from invite_codes where code = ${CODE}`;
}
async function finish() {
  await cleanup();
  const leftUsers = await sql`select count(*)::int as n from "user" where email in (${A}, ${B})`;
  console.log("\n" + results.join("\n"));
  console.log(`\nleftover test users after cleanup: ${leftUsers[0].n}`);
  console.log(`\n${fail === 0 ? "ALL PASS ✅" : "SOME FAIL ❌"}  (${pass} pass / ${fail} fail)`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); finish(); });
