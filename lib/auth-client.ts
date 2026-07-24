import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

// ---------------------------------------------------------------------------
// Client-usable Better Auth instance (React hooks). Uses only the PUBLIC base
// URL — no secret ever reaches the client bundle. Same-origin in the browser,
// so the base URL is optional there; NEXT_PUBLIC_BETTER_AUTH_URL overrides for
// non-same-origin setups.
// ---------------------------------------------------------------------------

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
  plugins: [magicLinkClient()],
});
