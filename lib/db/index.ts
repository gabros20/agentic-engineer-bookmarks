import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

// Runtime client over Neon's serverless HTTP driver (pooled DATABASE_URL).
// HTTP transport suits Vercel functions; migrations use the direct
// (unpooled) URL via drizzle.config.ts instead.
const sql = neon(process.env.DATABASE_URL!);

export const db = drizzle(sql, { schema });

export { schema };
