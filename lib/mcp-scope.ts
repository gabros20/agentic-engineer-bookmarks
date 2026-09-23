// The one OAuth resource scope the MCP tools require (read-only access to the archive). Its own
// module so the client-side consent screen can label it without importing server-only lib/auth.
export const MCP_SCOPE = "bookmarks:read";
