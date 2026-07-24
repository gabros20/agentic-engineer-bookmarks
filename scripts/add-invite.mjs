// Issue a new invite code so the owner can invite people without hand-writing SQL.
// Self-contained (raw SQL, no TS imports) so it runs under plain `node`.
//
//   node scripts/add-invite.mjs <CODE> [label] [maxUses]
//
//   CODE      the invite code someone will redeem on the login screen (required)
//   label     a human note, e.g. a person's name (optional)
//   maxUses   cap on how many accounts this code can create (optional; omit = unlimited)
//
// Examples:
//   node scripts/add-invite.mjs river-otter-42            # unlimited, no label
//   node scripts/add-invite.mjs river-otter-42 "Sam" 1    # single-use, labelled "Sam"
//
// Needs DATABASE_URL(_UNPOOLED) in .env.local (same as the other db scripts).
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

const [, , codeArg, labelArg, maxUsesArg] = process.argv;
const code = codeArg?.trim();
if (!code) {
  console.error("Usage: node scripts/add-invite.mjs <CODE> [label] [maxUses]");
  process.exit(1);
}

const label = labelArg?.trim() || null;
let maxUses = null;
if (maxUsesArg !== undefined) {
  maxUses = Number.parseInt(maxUsesArg, 10);
  if (!Number.isInteger(maxUses) || maxUses < 1) {
    console.error(`maxUses must be a positive integer, got: ${maxUsesArg}`);
    process.exit(1);
  }
}

const dbUrl = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!dbUrl) throw new Error("DATABASE_URL(_UNPOOLED) must be set");

const sql = neon(dbUrl);
const id = crypto.randomUUID();
const rows = await sql`
  insert into invite_codes (id, code, label, "maxUses")
  values (${id}, ${code}, ${label}, ${maxUses})
  on conflict (code) do nothing
  returning id
`;

if (rows.length) {
  console.log(
    `Created invite code "${code}"` +
      (label ? ` (label: ${label})` : "") +
      (maxUses === null ? " — unlimited uses." : ` — max ${maxUses} use(s).`),
  );
} else {
  console.log(`Invite code "${code}" already exists — no change.`);
}
