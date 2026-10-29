import { AsyncLocalStorage } from "node:async_hooks";

// ---------------------------------------------------------------------------
// One sign-in email carrying BOTH the magic link and the 6-digit code.
//
// Better Auth issues them from two plugins (magicLink, emailOTP), each with its own send
// hook. POST /api/login/send runs both inside `collectSignInEmail`; while a collection is
// active the hooks in lib/auth.ts hand their link / code to it instead of emailing, and the
// route sends one combined email. Outside a collection (the bare endpoints) each hook emails
// as before. Server-only (node:async_hooks).
// ---------------------------------------------------------------------------

export type SignInEmailParts = { url?: string; otp?: string };

const store = new AsyncLocalStorage<SignInEmailParts>();

/** Run `fn` collecting what the sign-in send hooks produce, instead of emailing it. */
export async function collectSignInEmail(fn: () => Promise<void>): Promise<SignInEmailParts> {
  const parts: SignInEmailParts = {};
  await store.run(parts, fn);
  return parts;
}

/** The active collection, if this send hook runs inside collectSignInEmail. */
export function activeSignInEmail(): SignInEmailParts | undefined {
  return store.getStore();
}
