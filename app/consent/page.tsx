import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ConsentForm } from "@/components/auth/consent-form";
import { auth } from "@/lib/auth";
import { LanguageProvider } from "@/lib/i18n";

// MCP OAuth consent screen (lib/auth.ts `mcp({ consentPage: "/consent" })`). Better Auth's
// authorize endpoint redirects here — with the original authorize query + a signature — once the
// user has a session but hasn't yet approved this client. Nothing is issued until the user clicks
// Allow (components/consent-form.tsx → POST /api/auth/oauth2/consent).
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ConsentPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const clientId = first(params.client_id);

  // Session is required (the consent is recorded against the user). The optimistic proxy wall
  // already bounces cookie-less requests; this is the authoritative check.
  const requestHeaders = await headers();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/login");

  let clientName: string | null = null;
  let clientUri: string | null = null;
  if (clientId) {
    try {
      const client = await auth.api.getOAuthClientPublic({ query: { client_id: clientId }, headers: requestHeaders });
      clientName = client.client_name ?? null;
      clientUri = client.client_uri ?? null;
    } catch {
      // Unknown/disabled client: the form still renders, and the consent POST itself fails
      // server-side, so no access can be granted to it.
    }
  }

  let redirectHost: string | null = null;
  // A native app's loopback listener (RFC 8252: http://localhost:<port>/callback, how Claude Code,
  // Cursor, … receive the result): it only exists on the computer that started the connection.
  let loopback = false;
  try {
    const redirectUri = first(params.redirect_uri);
    if (redirectUri) {
      const url = new URL(redirectUri);
      redirectHost = url.host;
      loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    }
  } catch {
    redirectHost = null;
  }

  const scopes = (first(params.scope) ?? "").split(" ").filter(Boolean);

  return (
    <LanguageProvider>
      <ConsentForm
        clientName={clientName}
        clientUri={clientUri}
        redirectHost={redirectHost}
        loopback={loopback}
        scopes={scopes}
        email={session.user.email}
      />
    </LanguageProvider>
  );
}
