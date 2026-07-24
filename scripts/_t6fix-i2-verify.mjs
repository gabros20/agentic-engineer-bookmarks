// T6 fix (I2) verification (throwaway). Proves the live Neon UNIQUE(userId,query) constraint +
// onConflictDoUpdate semantics: regenerating a digest for the same (user, query) REPLACES the row
// instead of appending, and deleting the shown row leaves nothing to resurface. Cleans up fully.
import { readFileSync } from "node:fs";
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
const sql = neon(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL);

const TS = Date.now();
const uid = `t6fix-u-${TS}`;
const email = `t6fix-${TS}@example.com`;
const QUERY = "agents (from:simonw)";
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`); ok ? pass++ : fail++; };

// Mirror app/api/digest onFinish upsert at the SQL level.
async function upsert(content) {
  await sql`
    INSERT INTO "saved_digests" ("id","userId","title","query","precision","content","sourceIds","language","createdAt")
    VALUES (${crypto.randomUUID()}, ${uid}, ${QUERY}, ${QUERY}, NULL, ${JSON.stringify({ overall: content })}::jsonb, ${JSON.stringify(["a","b"])}::jsonb, 'en', NOW())
    ON CONFLICT ("userId","query") DO UPDATE SET
      "title" = EXCLUDED."title", "precision" = NULL, "content" = EXCLUDED."content",
      "sourceIds" = EXCLUDED."sourceIds", "language" = EXCLUDED."language", "createdAt" = NOW()`;
}

try {
  await sql`INSERT INTO "user" ("id","name","email","emailVerified") VALUES (${uid}, 'T6 Fix', ${email}, true)`;

  // Constraint is live.
  const [con] = await sql`SELECT 1 AS ok FROM pg_constraint WHERE conname = 'saved_digests_userId_query_uq'`;
  check("UNIQUE(userId,query) constraint exists on saved_digests", !!con);

  // Generate + regenerate the SAME (user, query) twice.
  await upsert("gen-1");
  await upsert("gen-2");
  const rows = await sql`SELECT "id","content" FROM "saved_digests" WHERE "userId" = ${uid} AND "query" = ${QUERY}`;
  check("regenerate leaves exactly ONE row for (user, query)", rows.length === 1, `count=${rows.length}`);
  check("the surviving row is the latest generation (gen-2)", rows[0]?.content?.overall === "gen-2", `overall=${rows[0]?.content?.overall}`);

  // Delete the shown row (user-scoped, as DELETE /api/digests/[id] does).
  await sql`DELETE FROM "saved_digests" WHERE "id" = ${rows[0].id} AND "userId" = ${uid}`;
  const after = await sql`SELECT "id" FROM "saved_digests" WHERE "userId" = ${uid} AND "query" = ${QUERY}`;
  check("after delete, NO older generation resurfaces (0 rows)", after.length === 0, `count=${after.length}`);
} finally {
  await sql`DELETE FROM "user" WHERE "id" = ${uid}`; // cascades any digest rows
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM "saved_digests" WHERE "userId" = ${uid}`;
  check("cleanup: 0 leftover rows for test user", n === 0, `count=${n}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
