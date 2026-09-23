import { auth } from "@/lib/auth";

// OAuth discovery for the MCP server (RFC 9728 protected-resource metadata + RFC 8414
// authorization-server / OIDC metadata). MCP clients probe these ROOT-level paths, e.g.
//   /.well-known/oauth-protected-resource/api/mcp
//   /.well-known/oauth-authorization-server/api/auth
// which Next would otherwise 404 (Better Auth is mounted under /api/auth). Better Auth's
// mcp()/oauth-provider plugins answer them from `auth.handler` by pathname, so forward
// verbatim; anything they don't recognise falls through to Better Auth's own 404.
// Public by design (allow-listed in proxy.ts): discovery documents hold no secrets.
export const runtime = "nodejs";

export function GET(request: Request) {
  return auth.handler(request);
}
