# MCP server plan — search the archive from any MCP client

**Goal:** expose the web app's search as a remote MCP server (`/api/mcp`), with the same ranking, operators, content filters and per-user quota as the web app, behind the same invite-gated login, and without changing the Worker, the ranking math, or the security semantics of the existing routes.

Status: **implemented** on branch `feat/mcp-server` (see the validation log below). User docs are in the README's *MCP server* section.

## 1. Gaps found in the app (fixed first)

| Gap | Why it blocked MCP | Fix |
|---|---|---|
| Search results were bare `{id, score}`; every consumer (UI, ⌘K chat, digest) hydrated ids against the archive **the browser** had downloaded | A server-side caller has no archive, so it would get ids with no text | `lib/server/bookmark-service.ts` loads the archive server-side through the existing secret-gated Worker `GET /archive` (R2), caches it per function instance (5-min TTL; a failed refresh serves the stale copy) and hydrates ranked ids |
| `from:`/`before:`/`after:` and the content-type filter were applied only inside `components/bookmarks-app.tsx` | Same logic unavailable on the server; duplicating it would drift | Extracted to **`lib/bookmark-filters.ts`** (`matchesOperators`, `matchesContentFilter`, `searchable`, `postTime`, `toSearchHit`, `toBookmarkDetail`). The UI now imports them too, with unchanged semantics |
| LLM query rewrites (`/api/expand`) could only be called by the browser (session cookie) | Broad search from MCP would lose the Hungarian→English recall boost | Prompt + model moved to **`lib/server/query-expand.ts`**, shared by `/api/expand` and the MCP tool (same 1.5 s budget and ≥3-char guard as the browser) |
| The Worker forward was inlined in `/api/search`; the search limit was a route-local constant | A second caller would duplicate the timeout/secret/abort plumbing and could get its own quota | **`lib/server/search-upstream.ts`** (`getWorkerConfig`, `forwardWorkerSearch`, `parseRankedResults`); `DAILY_SEARCH_LIMIT` exported from `lib/api-guard.ts`, so **one bucket covers the UI and MCP** |
| Better Auth 1.6 had no MCP-grade OAuth server | MCP clients need OAuth 2.1 + RFC 9728/8414 discovery | Upgraded to Better Auth **1.7.5** + `@better-auth/mcp` + `@better-auth/cimd` |

`/api/search` was refactored onto the shared upstream helper with **identical** behavior (same 12 s timeout composed with the request signal, same 500/502 mapping, same pass-through body/status, same quota order).

## 2. Design

```text
MCP client ──Bearer JWT──▶ app/api/mcp/route.ts
   requireMcpAuth(auth, …, { resource: MCP_RESOURCE, requiredScopes: ["bookmarks:read"] })
     – verifies the JWT locally against /api/auth/jwks: signature, issuer, audience, expiry, scope
     – 401 + WWW-Authenticate(resource_metadata=…) when missing/invalid → the client starts OAuth
   createMcpHandler(factory)  – @modelcontextprotocol/server v2: 2026-07-28 native + stateless 2025 fallback
     factory(authInfo) → McpServer with tools bound to userId = token.sub
       search_bookmarks → bookmark-service.searchBookmarks (quota: "search", 300/day, shared)
       get_bookmark     → bookmark-service.getBookmark      (no quota)
```

**OAuth flow (Better Auth as the authorization server):**

1. Client → `POST /api/mcp` → 401 → reads `/.well-known/oauth-protected-resource/api/mcp` → `/.well-known/oauth-authorization-server/api/auth` (both served by `app/.well-known/[...path]` → `auth.handler`).
2. Client identifies itself with **CIMD** (a `client_id` that is an https URL, MCP 2026-07-28) or registers via **open DCR** (`/api/auth/oauth2/register`).
3. `/api/auth/oauth2/authorize` without a session → `/login?<authorize query>&sig=…`.
4. **Magic-link resume** (`components/login-form.tsx`): Better Auth's built-in resume attaches to the *sign-in request*, but a magic link signs in later, from the email. So when `/login` carries an authorize query, the magic link's `callbackURL` becomes the original `/api/auth/oauth2/authorize?…` request (signature params and `prompt=login` removed). Clicking the link sets the session and lands back on authorize, which continues to consent. Replaying the query needs no trust: authorize re-validates the client + redirect_uri, and nothing is granted without consent.
5. `/consent` (server page: session check, client name/uri, redirect host, scope list; EN/HU) → Allow/Deny → `POST /api/auth/oauth2/consent` via a dedicated `oauthProviderClient()` instance that attaches the page's signed query → redirect to the client with the code.
6. Token: resource-bound JWT access token (1 h) + refresh token (30 d, 30 s reuse window per the mcp() default).

## 3. Decisions

- **Host on Vercel (Next route), not in the Worker.** Auth, sessions, quota and invites all live in Next + Neon; the Worker stays a secret-gated ranking engine. No Worker deploy and no ranking/eval impact.
- **Hydrate in Vercel, not in the Worker.** The alternative (a `hydrate` flag on Worker `/search`) would add an 11 MB archive parse to every Worker isolate that already holds the lunr + vector index (128 MB limit), and would need an atomic Worker deploy. Vercel functions have plenty of memory, and Fluid Compute reuses instances, so the cache is usually warm.
- **One quota bucket.** MCP searches count as `search` in `ai_usage_daily` with the web limit (300/day). Connecting a client never multiplies a user's billable Workers-AI budget. Operators-only listings and `get_bookmark` never reach the Worker, so they're free (UI parity).
- **Open DCR + CIMD.** CIMD is the MCP 2026-07-28 mechanism. Open DCR is kept on because many clients still only do DCR. It's safe because registration yields no access: a token needs an invite-gated account's login **and** explicit consent (the consent screen shows the client name and the redirect host).
- **Native-client inference on registration** (`hooks.before` in `lib/auth.ts`). Better Auth defaults a DCR registration without `application_type` to `"web"`, and web clients may not use loopback redirects. Claude Code, Cursor and the MCP Inspector register exactly that way (`http://localhost:<port>/callback`, no `application_type`), so they got a 400. The hook sets `native` **only** when every redirect URI is an RFC 8252 native redirect (http on exact loopback, or a private-use scheme). https/mixed lists keep the strict default.
- **Transport fallback kept (not `legacy: "reject"`).** Better Auth's docs show a modern-only endpoint, but many clients still speak 2025-era MCP. The SDK's stateless fallback serves them per request with no session store.
- **Read-only tools, `openWorldHint: false`.** No mutations are exposed (favorites and digests stay UI-only for now).

## 4. Schema

`drizzle/0005_*.sql` **only adds tables** (Better Auth 1.7 plugin schema from `getAuthTables`, pg adapter: native `text[]` + `jsonb`): `jwks`, `oauthClient`, `oauthResource`, `oauthClientResource`, `oauthAccessToken`, `oauthRefreshToken`, `oauthConsent`, `oauthClientAssertion`. Core Better Auth tables are unchanged (verified: identical field sets). CIMD adds no tables; DPoP replay reservations reuse `verification`. It's safe to run against the live DB before the code ships.

Note: `npx auth generate` can't run here (the `@/` alias, and the OAuth plugin's init queries the DB). The schema was hand-written from `getAuthTables(...)` output and matches it field-for-field.

## 5. Rollout

1. `npm run db:migrate` against production (only adds tables; the live app ignores them). *Done 2026-09-23 while testing, on the shared Neon DB.*
2. No new env vars. `BETTER_AUTH_URL` must be the canonical origin (`https://xbookmarks.tamasgabor.com`): it defines the issuer, the JWKS URL and the MCP resource (`${BETTER_AUTH_URL}/api/mcp`).
3. Merge → Vercel deploy. **No `deploy:worker`, no `upload:r2`.**
4. Smoke: `curl -i -X POST https://xbookmarks.tamasgabor.com/api/mcp` → `401` with `WWW-Authenticate: Bearer resource_metadata=…`; then connect Claude Code (`claude mcp add --transport http …`).

## 6. Validation log (local, 2026-09-23)

- `tsc --noEmit` clean; `next build` clean (no warnings); `npm run test:search` 51/51, `npm run test:operators` 24/24.
- Discovery: PRM + AS metadata served; unauthenticated `/api/mcp` → 401 + correct `WWW-Authenticate`; tampered token → 401.
- Full OAuth E2E (scripted with the `MAGIC_LINK_SINK` dev seam): DCR (loopback, no `application_type`) 201 → authorize 302 `/login` → invite + magic link with resume callback → verify 302 authorize → 302 `/consent` (renders client name) → consent → code → token 200 (`bookmarks:read offline_access`, refresh token).
- Tools: `initialize` (2025-06-18 fallback) + `tools/list`; broad semantic search ranked; Hungarian query + `filter:"article"`; `from:` + `after:` operators-only listing (newest-first, matches archive counts); explicit `from` + exact; invalid `before:` date → warning, still searches; empty query → tool error; `get_bookmark` hit + miss.
- Web regression on Better Auth 1.7: invite + magic link login → `/` 200; `/api/search` 200 reranked; `/api/archive` 200 (11 MB); `/api/expand` 200.
- Registration guard: `http://evil.example/cb` is still rejected; `https://claude.ai/...` is accepted as a web client.
- Test data (OAuth clients/tokens/consents, script sessions) was deleted from the shared DB afterwards.

## 7. Follow-ups (not done)

- A "Connected apps" UI (list/revoke `oauthConsent` + refresh tokens). Today, revoke by deleting rows, or wait for the refresh token to expire.
- Optional tools: `digest` (draws on the digest quota), `similar_bookmarks`, favorites.
- A per-client rate limit on top of the per-user quota, if DCR abuse ever shows up (registration itself is cheap and grants nothing).
