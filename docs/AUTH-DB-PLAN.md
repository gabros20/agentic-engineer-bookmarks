# Auth + DB persistence plan — invite-gated accounts, cross-device sync, per-user AI quotas

Make the app a **fully private, invite-only** application with real user accounts, persist AI Digest + ⌘K
chat sessions in a database keyed to the user (single source of truth across mobile + desktop), and enforce
per-user daily limits so nobody can burn OpenRouter tokens or Workers AI credits.

**Branch:** `auth-db` (off `main`) · **Strategy:** `/orchestrate` staged, **opus** implementers, spec→quality dual review per task.

---

## Decisions (locked with the user + the Fable5 / GPT-5.6 / Grok-4.5 advisory panel)

| Area | Decision |
|---|---|
| **Stack** | **A — Vercel-centric.** Next.js app + AI routes stay on Vercel; the Cloudflare search Worker stays as-is (locked down). Unanimous panel rec. |
| **Database** | **Neon Postgres** (Vercel Marketplace, free tier) + **Drizzle ORM** + drizzle-kit migrations. |
| **Auth** | **Better Auth** `magicLink` plugin (passwordless email link). **DB-backed sessions** (opaque token in httpOnly/Secure/SameSite=Lax cookie) — NOT JWT, so revocation + quota checks stay trivial. |
| **Email** | **Resend** (`sendMagicLink` hook). |
| **Access gate** | **Invite code**, repurposed from today's `DIGEST_UNLOCK_SECRET` value (existing insiders keep the same code). Account creation is **blocked** unless a valid invite code was redeemed. Email = identity only (to attach sessions to a person); the *code* grants access. |
| **App scope** | **Fully private.** The entire app (browse, search, digest, chat) sits behind the login wall. Landing page → login screen. |
| **Worker security** | **Proxy through Vercel.** Browser → `/api/search` (session + quota check in Neon) → Worker with a server-only shared secret (`SEARCH_PROXY_SECRET`). The Worker rejects any request without the secret — the open back door closes. Client stops calling the Worker directly. |
| **Daily limits (per user, reset daily)** | **10 digests · 40 chat messages · 300 searches.** Tracked in Neon (`ai_usage_daily`), enforced server-side, 429 on exceed. |
| **Cross-device sync** | DB is source of truth. Digest persisted **server-side** on stream finish (survives a closed tab). Chat persisted per settled turn. One-shot migration of existing localStorage/IndexedDB data on first login. IndexedDB kept only as a read cache (server always wins). |
| **Retire** | The `digest_unlock` passkey cookie gate on `/api/digest` + `/api/chat` — real sessions replace it. |

### Verified library facts (Context7 / bundled AI SDK docs, checked against our installed versions)
- We are on `ai@6.0.193`, `@ai-sdk/react@3.0.195`, `next@16.2.6`, `react@19.2.6`, `zod@4` — **current AI SDK generation; no upgrade needed.**
- **Digest** (`streamObject` → `toTextStreamResponse`) persists cleanest **server-side**: `streamObject({ … , onFinish })` + Next `after()` (from `next/server`) for the DB write, and `result.consumeStream()` so `onFinish` fires even if the client disconnects. Implementer: confirm `onFinish`/`consumeStream` shapes in `node_modules/ai/docs/`.
- **Chat** uses **client-side tool execution** (schema-only tools; the browser drives the search + multi-step loop), so the whole conversation is assembled client-side → persist from the client after each settled turn via a save endpoint.
- **Better Auth** (verified current API): `magicLink({ sendMagicLink })` server plugin + `magicLinkClient()` client plugin; `toNextJsHandler(auth)` at `app/api/auth/[...all]/route.ts`; `drizzleAdapter(db, { provider: "pg" })`; **`databaseHooks.user.create.before`** throwing `APIError("BAD_REQUEST", …)` is the exact hook to enforce the invite gate. `magicLink.storeToken: "hashed"` to avoid storing raw tokens.
- **Next.js 16**: request-gating file is **`proxy.ts`** (v16 renamed `middleware` → `proxy`). Implementer: verify the Better Auth session-cookie optimistic check pattern for the proxy against current docs (use the cookie presence check for redirect, real `auth.api.getSession` inside route handlers).

---

## Target architecture (after this change)

```
Browser (fully private SPA, session cookie)
  │  credentials: 'include' on every fetch
  ├─ /api/auth/[...all]      → Better Auth (magic link, sessions)         ── Neon
  ├─ /api/invite/verify      → redeem invite code → pending_signups        ── Neon
  ├─ /api/search             → session+quota → Worker (SEARCH_PROXY_SECRET) ── Neon + CF Worker
  ├─ /api/digest             → session+quota → OpenRouter; onFinish→save    ── Neon + OpenRouter
  ├─ /api/chat               → session+quota → OpenRouter (client tools)    ── Neon + OpenRouter
  ├─ /api/digests (CRUD)     → saved digests                                ── Neon
  ├─ /api/chats (CRUD)       → chat sessions + messages                     ── Neon
  └─ /api/migrate            → one-shot localStorage/IDB import             ── Neon

proxy.ts → unauthenticated request to any app route ⇒ redirect to /login
Cloudflare Worker → now requires SEARCH_PROXY_SECRET header; browser never calls it directly
```

### Schema (Drizzle / Postgres)
Better-Auth-managed: `user`, `session`, `account`, `verification` (generate via Better Auth CLI / snapshot; do **not** hand-edit their shape).

App-owned:
```
invite_codes    id, code UNIQUE, label, max_uses (nullable=∞), used_count, active, created_at
pending_signups email PK, code_id FK, expires_at            -- redeemed code awaiting first magic-link create
saved_digests   id, user_id FK, title, query, precision, content JSONB, source_ids JSONB, language, created_at
chat_sessions   id, user_id FK, title, language, created_at, updated_at
chat_messages   id, session_id FK, seq, role, parts JSONB, created_at      -- store UIMessage parts verbatim
ai_usage_daily  user_id FK, day DATE, digest_count, chat_count, search_count   PK(user_id, day)
```
UUID/text ids, FKs with `onDelete: cascade`. `ai_usage_daily` incremented atomically (`INSERT … ON CONFLICT (user_id, day) DO UPDATE SET … = … + 1`), checked before the expensive call.

---

## Task plan (staged for `/orchestrate`, opus)

Sequence chosen so each task is independently verifiable and later tasks build on earlier ones. Tasks that both touch `components/bookmarks-app.tsx` (T3, T4, T6) are **serialized**, never parallel.

### T1 — Data layer foundation (no behavior change)
- Add deps: `drizzle-orm`, `drizzle-kit`, `@neondatabase/serverless` (or `pg`), `better-auth`, `resend`.
- `lib/db/schema.ts` (app tables above), `lib/db/index.ts` (Neon serverless Drizzle client), `drizzle.config.ts`.
- Generate + apply the initial migration to the Neon DB (needs `DATABASE_URL`).
- **Verify:** `drizzle-kit generate` clean; migration applies to Neon; `npm run build` + typecheck green. No app-visible change yet.

### T2 — Auth core (server + invite gate + email)
- `lib/auth.ts`: `betterAuth({ database: drizzleAdapter(db,{provider:"pg"}), plugins:[magicLink({ sendMagicLink, storeToken:"hashed" })], databaseHooks:{ user:{ create:{ before } } }, session config })`.
  - `create.before`: look up `pending_signups` by `user.email`; if missing/expired ⇒ `throw APIError("BAD_REQUEST", { message: "Invite required" })`. If valid ⇒ allow, and in `after` consume the pending row + `used_count++` and stamp the user's `code_id`.
- `lib/email.ts`: Resend `sendMagicLink` (EN + HU email copy).
- `lib/auth-client.ts`: `createAuthClient({ plugins:[magicLinkClient()] })`.
- `app/api/auth/[...all]/route.ts`: `toNextJsHandler(auth)`.
- `app/api/invite/verify/route.ts`: validate code (active, under `max_uses`) → upsert `pending_signups {email, code_id, expires_at:+15min}` → 200/400. Rate-limit by email+IP.
- Seed `invite_codes` with the current `DIGEST_UNLOCK_SECRET` value (script or migration seed).
- **Verify:** invited email receives a real magic link via Resend and logs in (session cookie set); a non-invited email is blocked by the hook; invite `used_count` increments. Requires `DATABASE_URL` + `RESEND_API_KEY` + `BETTER_AUTH_SECRET`.

### T3 — Login wall + auth UI (touches bookmarks-app.tsx)
- `proxy.ts` (Next 16): redirect unauthenticated requests (optimistic session-cookie check) to `/login`; allow `/login`, `/api/auth/*`, static assets.
- `app/login/page.tsx`: two-step UI — (1) invite code + email → `POST /api/invite/verify` then `authClient.signIn.magicLink({ email })`; (2) "check your email" state. EN + HU.
- Session context/provider for the client; sign-out control; remove the old `digest_unlock` passkey UI/flow from `components/bookmarks-app.tsx`.
- **Verify:** unauthenticated → `/login`; full invited flow logs in and lands on the app; sign-out works; `npm run build` green.

### T4 — Search proxy + Worker lockdown + search quota (touches bookmarks-app.tsx, worker, lib/search-client.ts)
- `app/api/search/route.ts`: `requireUser()` → check+increment `ai_usage_daily.search_count` (429 over 300) → forward `{query,precision,rewrites,limit}` to the Worker with `X-Proxy-Secret: SEARCH_PROXY_SECRET` → return the Worker's JSON unchanged.
- `worker/src/index.ts`: require the shared secret header on `/search`; 401 otherwise. Tighten CORS (browser no longer calls it directly). Keep the ranking contract byte-identical.
- `lib/search-client.ts`: point `searchViaWorker` at same-origin `/api/search` (drop `NEXT_PUBLIC_SEARCH_ENDPOINT` from the browser path; the secret + real Worker URL live server-side), `credentials:"include"`.
- **Verify:** search works end-to-end through the proxy; a direct Worker call without the secret → 401; over-quota → 429; **`npm run eval:bge` still matches baseline** (ranking unchanged); `npm run test:search` + `test:operators` green; `npm run deploy:worker`.

### T5 — Gate AI endpoints + quota + server-side digest persistence
- `/api/digest` + `/api/chat`: replace the `digest_unlock` passkey with `auth.api.getSession({ headers })` → 401 if none; check+increment the matching daily counter (digest 10 / chat 40) → 429 over.
- Digest persistence: `streamObject({ …, onFinish })` + `consumeStream()` + `after(() => save to saved_digests for user_id)` so a finished digest is stored even if the tab closed.
- **Verify:** unauth → 401; over-quota → 429; a digest generated then tab-closed still lands in `saved_digests`; EN + HU both stream valid structured output.

### T6 — Chat/digest history + cross-device sync (touches bookmarks-app.tsx)
- CRUD: `app/api/digests/route.ts` (list/get/delete), `app/api/chats/route.ts` (+ `[id]`), reading/writing the Neon tables for the current user.
- Client: chat saves the settled conversation to `/api/chats` per turn (`chat_messages.parts` verbatim); saved-digests + chat-history panels read from DB via SWR/TanStack-Query with IndexedDB as a read cache.
- `app/api/migrate/route.ts` + one-shot client trigger: on first authed load, POST any legacy localStorage/IndexedDB digests/chats, then mark migrated.
- **Verify:** create a digest/chat, confirm it appears in a fresh browser session (different device simulation); legacy local data migrates exactly once; server wins on conflict; `npm run build` green.

### T7 — Hardening + docs
- Session TTL + refresh; invite/OTP rate-limit (email+IP) confirmed; `credentials:"include"` audit on every app→API fetch (the silent-401 gotcha); OpenRouter spend-alert note; ensure no secret is ever `NEXT_PUBLIC_*`.
- Docs: update `README.md`, `CLAUDE.md`, `docs/ENGINEERING-NOTES.md` (new auth/DB architecture + contracts), `docs/SYNC-AND-DEPLOY.md` (new env vars), and record outcomes here.
- **Verify:** full `npm run build`, `test:search`, `test:operators`, `eval:bge`, and a manual security pass (no unauth path to any expensive endpoint) all green.

---

## Manual prerequisites (user-only — cannot be automated; account creation)
1. **Neon Postgres**: create a DB (Vercel dashboard → Storage → Neon, or neon.tech) → get `DATABASE_URL` (pooled connection string).
2. **Resend**: create an account, add + verify a sending domain (or use `onboarding@resend.dev` for dev), get `RESEND_API_KEY`.
3. **Env vars** (local `.env.local` + Vercel project — the non-account secrets can be set via the authed `vercel` CLI):
   - `DATABASE_URL` (Neon) · `RESEND_API_KEY` (Resend) — *from steps 1–2*
   - `BETTER_AUTH_SECRET` · `SEARCH_PROXY_SECRET` — *pre-generated, ready to paste*
   - `BETTER_AUTH_URL` = prod URL / `http://localhost:3000` for dev
   - keep `OPENROUTER_API_KEY`; keep `DIGEST_UNLOCK_SECRET` (reused as the seed invite code, then the passkey *gate* is retired)
   - `SEARCH_PROXY_SECRET` also set as a Worker secret via `wrangler secret put`.

## Constraints
- TS strict; `npm run build` + all tests + the `eval:bge` gate stay green (ranking math untouched — T4 only adds a proxy + secret).
- EN + HU parity on every new user-facing string (login, emails, quota/errors).
- No secret in a `NEXT_PUBLIC_*` var or any client bundle.
- Worker ranking contract unchanged; `npm run deploy:worker` after T4.
- Two deploy targets rule still holds (see `docs/SYNC-AND-DEPLOY.md`).

## Rollout
All on `auth-db`; T1→T7 in order (T3/T4/T6 serialize on `bookmarks-app.tsx`). Whole-branch verify → merge to `main` (Vercel) + `npm run deploy:worker`. Set all env vars in Vercel **before** the first build (`NEXT_PUBLIC_*` inlining rule).
