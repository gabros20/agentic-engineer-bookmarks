import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";

import { db } from "@/lib/db";
import { sendMagicLinkEmail } from "@/lib/email";
import { consumeInvite, findValidPendingSignup } from "@/lib/invite";

// ---------------------------------------------------------------------------
// Better Auth server instance: passwordless magic-link over the Drizzle/Neon
// schema, DB-backed sessions (not JWT), with a HARD invite gate.
//
// Security crux: the ONLY way to create an account is a magic link, and
// `databaseHooks.user.create.before` aborts creation unless an unexpired
// `pending_signups` row (a redeemed invite code) exists for that email. A
// non-invited email therefore can never obtain a session. Returning users skip
// `create.before` entirely (Better Auth finds them by email first), so they log
// in with the link alone — the desired cross-device UX.
//
// Driver note: `lib/db` uses neon-http, which has no interactive
// `db.transaction()`. The Better Auth Drizzle pg adapter never calls
// `db.transaction()` (it uses `.returning()` for inserts and reports
// `transaction: false`), so neon-http is safe here. The one multi-statement
// step we own — consuming the invite — runs via `db.batch()` (see lib/invite).
// ---------------------------------------------------------------------------

const baseURL = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: Array.from(new Set(["http://localhost:3000", baseURL])),
  database: drizzleAdapter(db, { provider: "pg" }),
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh at most once per day
  },
  databaseHooks: {
    user: {
      create: {
        // THE GATE. Runs only for brand-new emails (returning users are found
        // by email before this fires). Throwing aborts user creation.
        before: async (user) => {
          const pending = await findValidPendingSignup(user.email);
          if (!pending) {
            throw new APIError("BAD_REQUEST", {
              message:
                "An invite code is required to create an account. / Fiók létrehozásához meghívókód szükséges.",
            });
          }
        },
        // Fires only on successful creation: consume the reservation and bump
        // the code's usedCount (single neon-http batch / server-side txn).
        after: async (user) => {
          await consumeInvite(user.email);
        },
      },
    },
  },
  plugins: [
    magicLink({
      // Store only a hash of the token in `verification.value`; the raw token
      // lives solely in the emailed URL.
      storeToken: "hashed",
      sendMagicLink: async ({ email, url }) => {
        // Test seam — NEVER set in production. When MAGIC_LINK_SINK points at a
        // file, capture the raw link there (the token is only in the URL under
        // hashed storage) and skip email, so integration tests don't depend on
        // inbox delivery. Unset in prod → always emails via Resend.
        if (process.env.MAGIC_LINK_SINK) {
          const { appendFile } = await import("node:fs/promises");
          await appendFile(
            process.env.MAGIC_LINK_SINK,
            JSON.stringify({ email, url }) + "\n",
          );
          return;
        }
        await sendMagicLinkEmail({ email, url });
      },
    }),
  ],
});
