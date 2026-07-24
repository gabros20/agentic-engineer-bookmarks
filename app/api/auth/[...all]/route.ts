import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";

// Better Auth's full REST surface (magic-link request + verify, session, sign
// out, …) mounted under /api/auth. Node runtime — the Drizzle/Neon client and
// Resend both need Node APIs.
export const runtime = "nodejs";

export const { GET, POST } = toNextJsHandler(auth);
