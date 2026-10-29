import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP, jwt, magicLink } from "better-auth/plugins";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";

import { db } from "@/lib/db";
import { sendMagicLinkEmail } from "@/lib/email";
import { activeSignInEmail } from "@/lib/sign-in-email";
import { MCP_SCOPE } from "@/lib/mcp-scope";
import {
  consumeInvite,
  emailMayReceiveMagicLink,
  findValidPendingSignup,
  isCodeRedeemable,
} from "@/lib/invite";

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

const baseURL = (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// MCP server authorization (app/api/mcp). Better Auth doubles as the OAuth 2.1
// authorization server for MCP clients (Claude Code, claude.ai, Cursor, …):
// `mcp()` is the OAuth provider bound to the MCP resource, `jwt()` signs the
// resource-bound access tokens (JWKS at /api/auth/jwks), `cimd()` lets clients
// identify themselves by a Client ID Metadata Document URL (MCP 2026-07-28).
//
// The invite gate is UNCHANGED: an OAuth authorization needs a Better Auth
// session, which still only exists for invite-created accounts (magic link →
// `user.create.before` above). Registering an OAuth client grants nothing by
// itself — every client must go through that login + the /consent screen.
// ---------------------------------------------------------------------------

/** Canonical MCP protected-resource URL — the token audience; must match app/api/mcp. */
export const MCP_RESOURCE = `${baseURL}/api/mcp`;
export { MCP_SCOPE };

/**
 * RFC 8252 native-app redirect: http on an exact loopback host (the client's local callback
 * listener, any port) or a private-use URI scheme. MCP clients like Claude Code, Cursor and the
 * MCP Inspector register with these but usually OMIT `application_type`, which Better Auth then
 * defaults to "web" — and web clients may not use loopback redirects, so the registration 400s.
 */
function isNativeRedirectUri(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  try {
    const url = new URL(uri);
    if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.protocol !== "https:";
  } catch {
    return false;
  }
}

/** Magic link and sign-in code lifetime: long enough to type a code read on another device. */
const SIGN_IN_TTL_SECONDS = 10 * 60;

/**
 * I2 send-gate, shared by the magic link and the sign-in code: `signIn.magicLink` /
 * `emailOtp.sendVerificationOtp` can be called directly, so without this an unauthenticated
 * caller could make us email ARBITRARY third-party addresses (send/Resend-cost + reputation
 * abuse). Account creation is still separately invite-gated (`user.create.before`); this only
 * bounds the SEND. Email only an already-known address: an existing user (returning login) OR a
 * valid unexpired invite reservation (invited signup). Otherwise skip silently — log without the
 * address, and do NOT throw (don't leak whether an email is known, and don't 500 the caller). On
 * a DB read error, fail SAFE: skip the send rather than fan out to strangers.
 */
async function mayEmail(email: string, what: string): Promise<boolean> {
  try {
    if (await emailMayReceiveMagicLink(email)) return true;
    console.warn(`[auth] ${what} send skipped: address not invited or known`);
  } catch (err) {
    console.error(`[auth] ${what} eligibility check failed; skipping send`, err);
  }
  return false;
}

/**
 * Test seam — NEVER set in production. When MAGIC_LINK_SINK points at a file, capture the raw
 * link / code there (under hashed storage they exist only in the email) and skip email, so
 * integration tests don't depend on inbox delivery. Hard-gated on NODE_ENV !== "production" too,
 * so even if the env var leaks into prod config the sink stays inert.
 */
async function sinkForTests(entry: Record<string, string>): Promise<boolean> {
  if (!process.env.MAGIC_LINK_SINK || process.env.NODE_ENV === "production") return false;
  const { appendFile } = await import("node:fs/promises");
  await appendFile(process.env.MAGIC_LINK_SINK, JSON.stringify(entry) + "\n");
  return true;
}

export const auth = betterAuth({
  baseURL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: Array.from(new Set(["http://localhost:3000", baseURL])),
  database: drizzleAdapter(db, { provider: "pg" }),
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh at most once per day
  },
  hooks: {
    // MCP dynamic client registration: infer `application_type: "native"` when the client didn't
    // say, and EVERY redirect URI is a native-app redirect (see isNativeRedirectUri). Mixed or
    // https lists keep Better Auth's default ("web") and its strict validation. Registration still
    // grants nothing by itself (login + consent required), and native clients get no secret.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/oauth2/register") return;
      const body = ctx.body as { application_type?: unknown; redirect_uris?: unknown } | undefined;
      if (!body || body.application_type !== undefined || !Array.isArray(body.redirect_uris)) return;
      if (!body.redirect_uris.length || !body.redirect_uris.every(isNativeRedirectUri)) return;
      return { context: { ...ctx, body: { ...body, application_type: "native" } } };
    }),
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
          // Re-check the reserved code is STILL redeemable: a code deactivated
          // or exhausted by other redemptions during the ≤15-min pending window
          // must not let this reservation through. Closes the mid-flight gap.
          if (!(await isCodeRedeemable(pending.codeId))) {
            throw new APIError("BAD_REQUEST", {
              message:
                "This invite code is no longer valid. / Ez a meghívókód már nem érvényes.",
            });
          }
        },
        // Fires only on successful creation: consume the reservation and bump
        // the code's usedCount (single neon-http batch / server-side txn). This
        // runs AFTER the session + cookie are already set (queued post-txn), so
        // a failure here must never crash the hook drain or revoke the granted
        // access. Fail safe: swallow + log — the pending row simply lingers to
        // its 15-min expiry (still counted against maxUses at reserve) and
        // usedCount isn't bumped; the invited user correctly keeps access.
        after: async (user) => {
          try {
            await consumeInvite(user.email);
          } catch (err) {
            console.error(
              `[auth] consumeInvite failed after creating user ${user.email}; ` +
                "pending_signups row left to expire, usedCount not incremented",
              err,
            );
          }
        },
      },
    },
  },
  plugins: [
    magicLink({
      // Store only a hash of the token in `verification.value`; the raw token
      // lives solely in the emailed URL.
      storeToken: "hashed",
      expiresIn: SIGN_IN_TTL_SECONDS,
      sendMagicLink: async ({ email, url }) => {
        if (!(await mayEmail(email, "magic-link"))) return;
        if (await sinkForTests({ email, url })) return;
        // Inside POST /api/login/send: hand the link over; it goes out with the code in ONE email.
        const collecting = activeSignInEmail();
        if (collecting) {
          collecting.url = url;
          return;
        }
        await sendMagicLinkEmail({ email, url });
      },
    }),
    // The 6-digit sign-in code that travels with the magic link: typed on the device where
    // sign-in STARTED (components/login-form.tsx), so reading the email on a phone can finish a
    // sign-in begun on a computer — the case that matters for MCP clients like Claude Code, whose
    // OAuth redirect is a loopback listener on that computer. Same send-gate as the link; a
    // brand-new email still hits the invite gate (`user.create.before`) on verify.
    emailOTP({
      otpLength: 6,
      expiresIn: SIGN_IN_TTL_SECONDS,
      allowedAttempts: 5,
      storeOTP: "hashed",
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "sign-in") return; // only sign-in codes are used here
        if (!(await mayEmail(email, "sign-in code"))) return;
        if (await sinkForTests({ email, otp })) return;
        const collecting = activeSignInEmail();
        if (collecting) {
          collecting.otp = otp;
          return;
        }
        await sendMagicLinkEmail({ email, otp });
      },
    }),
    jwt(),
    mcp({
      resource: MCP_RESOURCE,
      // /login resumes the authorize request via the magic link's callbackURL (components/
      // login-form.tsx); /consent is the allow/deny screen (app/consent).
      loginPage: "/login",
      consentPage: "/consent",
      scopes: ["openid", "profile", "email", "offline_access", MCP_SCOPE],
      // Open RFC 7591 registration, alongside CIMD, so MCP clients that don't do CIMD yet can
      // still connect. Safe here: registration yields no access on its own — a token still needs
      // an invite-gated account's login AND explicit consent.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }),
    cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
  ],
});
