import { requireMcpAuth } from "@better-auth/mcp";
import { type AuthInfo, McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

import { MCP_RESOURCE, MCP_SCOPE, auth } from "@/lib/auth";
import { BookmarkServiceError, getBookmark, searchBookmarks } from "@/lib/server/bookmark-service";

// ---------------------------------------------------------------------------
// MCP server — the web app's bookmark search, exposed to MCP clients (Claude
// Code, claude.ai connectors, Cursor, …) over Streamable HTTP at /api/mcp.
//
// Auth: OAuth 2.1 via Better Auth (lib/auth.ts `mcp()`); `requireMcpAuth`
// verifies the resource-bound JWT access token locally against the JWKS
// (signature, issuer, audience = MCP_RESOURCE, expiry) and enforces MCP_SCOPE.
// No token → 401 + RFC 9728 `WWW-Authenticate`, which starts the client's
// login flow (→ /login magic link → /consent). The token `sub` is the Better
// Auth user id, so quota + access are per-user exactly like the web UI.
//
// Transport: stateless. Serves the MCP 2026-07-28 revision natively and falls
// back to per-request stateless serving for 2025-era clients (no session store,
// fits Vercel functions). Tools are read-only.
//
// Tools (lib/server/bookmark-service.ts — same ranking/filters as the UI):
//   search_bookmarks — hybrid keyword+semantic+rerank search; counts against
//                      the SAME 300/day search quota as the web UI.
//   get_bookmark     — one post in full (incl. X Article body); no quota.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
// Cold path = archive load (~11 MB via Worker/R2) + rewrite LLM (≤1.5 s) + Worker search (≤12 s).
export const maxDuration = 60;

const searchInputSchema = z.object({
  query: z
    .string()
    .max(300)
    .describe(
      'Natural-language search. May embed operators: "from:handle", "after:YYYY-MM[-DD]" (inclusive), ' +
        '"before:YYYY-MM[-DD]" (exclusive). An operators-only query lists matching bookmarks newest-first.',
    ),
  precision: z
    .enum(["exact", "broad"])
    .default("broad")
    .describe(
      "exact = no synonym expansion, keyword-weighted (handles, literal terms); broad = synonym + LLM " +
        "rewrite expansion, semantic-weighted (topics, vibes, non-English queries).",
    ),
  limit: z.number().int().min(1).max(60).default(20).describe("Max results (default 20, max 60)."),
  filter: z
    .enum(["all", "article", "media", "text"])
    .default("all")
    .describe("Content type: article = X Articles/long-form, media = has images/video, text = no media."),
  from: z.string().max(40).optional().describe("Only posts by this X handle (with or without @)."),
  after: z.string().max(10).optional().describe("Only posts on/after this date (YYYY-MM or YYYY-MM-DD)."),
  before: z.string().max(10).optional().describe("Only posts before this date (YYYY-MM or YYYY-MM-DD)."),
});

const getBookmarkInputSchema = z.object({
  id: z.string().min(1).max(40).describe("Bookmark id, as returned by search_bookmarks."),
});

const SERVER_INSTRUCTIONS = [
  "Private archive of the user's X (Twitter) bookmarks — mostly AI agents, LLMs and coding tools.",
  "Use search_bookmarks to find posts (it returns short excerpts + ids), then get_bookmark for the",
  "full text of the most relevant ones (X Articles can be long). Cite posts by their url.",
  "search_bookmarks is metered (daily quota shared with the web app); get_bookmark is free.",
].join(" ");

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function serviceErrorMessage(err: unknown): string {
  if (err instanceof BookmarkServiceError) {
    if (err.code === "search_quota" || err.code === "invalid_query") return err.message;
    if (err.code === "archive_unavailable") return "The bookmark archive is temporarily unavailable. Try again shortly.";
  }
  console.error("[mcp] tool failed:", err);
  return "Internal error while searching bookmarks.";
}

function buildServer(authInfo: AuthInfo | undefined): McpServer {
  const userId = typeof authInfo?.extra?.userId === "string" ? authInfo.extra.userId : null;

  const server = new McpServer(
    { name: "x-bookmarks", title: "X Bookmarks", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "search_bookmarks",
    {
      title: "Search bookmarks",
      description:
        "Search the user's X bookmark archive with the web app's hybrid ranking (keyword + semantic + " +
        "reranker). Returns ranked excerpts with ids, urls, dates and engagement. Counts against the " +
        "user's daily search quota unless the query is operators-only.",
      inputSchema: searchInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input, ctx) => {
      if (!userId) return toolError("Unauthorized.");
      try {
        return json(await searchBookmarks(input, { userId, signal: ctx.mcpReq?.signal }));
      } catch (err) {
        return toolError(serviceErrorMessage(err));
      }
    },
  );

  server.registerTool(
    "get_bookmark",
    {
      title: "Get bookmark",
      description:
        "Fetch one bookmark in full by id: complete post text, X Article title + body (markdown), author, " +
        "date, metrics and url. Does not count against the search quota.",
      inputSchema: getBookmarkInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      if (!userId) return toolError("Unauthorized.");
      try {
        const bookmark = await getBookmark(id);
        return bookmark ? json(bookmark) : toolError(`No bookmark with id ${id}.`);
      } catch (err) {
        return toolError(serviceErrorMessage(err));
      }
    },
  );

  return server;
}

const mcpHandler = createMcpHandler(({ authInfo }) => buildServer(authInfo));

const handle = requireMcpAuth(
  auth,
  (request, claims) => {
    const scopes = typeof claims.scope === "string" ? claims.scope.split(" ").filter(Boolean) : [];
    const authInfo: AuthInfo = {
      token: "",
      clientId: typeof claims.azp === "string" ? claims.azp : typeof claims.client_id === "string" ? claims.client_id : "",
      scopes,
      expiresAt: claims.exp,
      resource: new URL(MCP_RESOURCE),
      extra: { userId: claims.sub },
    };
    return mcpHandler.fetch(request, { authInfo });
  },
  { resource: MCP_RESOURCE, requiredScopes: [MCP_SCOPE] },
);

export { handle as DELETE, handle as GET, handle as POST };
