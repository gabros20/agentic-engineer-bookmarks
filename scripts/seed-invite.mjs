// Idempotently seed the owner's DIGEST_UNLOCK_SECRET as an invite code (label
// "seed") so the existing passkey works as an invite. Self-contained (raw SQL,
// no TS imports) so it runs under plain `node`. The verify route also seeds
// on first use; this script is for explicit ops.
//
//   npm run db:seed-invite
//
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

// drizzle-kit's config does the same: Node scripts don't get .env.local for free.
function loadEnvLocal() {
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const [, key, value] = m;
      if (process.env[key] === undefined) {
        process.env[key] = value.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // fall back to the ambient environment
  }
}

loadEnvLocal();

const dbUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
const secret = process.env.DIGEST_UNLOCK_SECRET;
if (!dbUrl) throw new Error("DATABASE_URL(_UNPOOLED) must be set");
if (!secret) throw new Error("DIGEST_UNLOCK_SECRET must be set to seed the invite code");

const sql = neon(dbUrl);
const id = crypto.randomUUID();
const rows = await sql`
  insert into invite_codes (id, code, label)
  values (${id}, ${secret}, 'seed')
  on conflict (code) do nothing
  returning id
`;

console.log(rows.length ? `Seeded invite code (id ${rows[0].id}).` : "Seed invite code already present — no change.");
