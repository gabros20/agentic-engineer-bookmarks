import { readFileSync } from "node:fs";

import { defineConfig } from "drizzle-kit";

// drizzle-kit's CLI does not auto-load .env.local (that's Next-only), so parse
// it here. Migrations run against the DIRECT/unpooled URL — pgbouncer (the
// pooled endpoint) rejects some DDL.
function loadEnvLocal() {
  try {
    const raw = readFileSync(new URL(".env.local", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const [, key, value] = match;
      if (process.env[key] === undefined) {
        process.env[key] = value.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // fall back to whatever is already in the environment
  }
}

loadEnvLocal();

const migrationUrl =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;

if (!migrationUrl) {
  throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) must be set");
}

export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: migrationUrl,
  },
});
