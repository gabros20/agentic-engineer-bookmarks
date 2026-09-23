import { NextResponse, type NextRequest } from "next/server";

import { DAILY_SEARCH_LIMIT, enforceQuota, requireUser } from "@/lib/api-guard";
import { forwardWorkerSearch, getWorkerConfig } from "@/lib/server/search-upstream";

// Authenticated search proxy (T4). ALL search now flows through here: the browser
// (lib/search-client.ts) POSTs same-origin to /api/search, this route checks the Better Auth
// session + a per-user daily search quota, then forwards to the Cloudflare Worker with a
// server-only shared secret (SEARCH_PROXY_SECRET). The Worker rejects anything without that
// secret, so the billable Workers-AI pipeline can no longer be hit directly. Ranking is
// UNCHANGED — this route adds auth + a hop and passes the Worker's { results, phase } through
// verbatim. The real Worker URL and the secret live ONLY on the server (never NEXT_PUBLIC_*).
export const runtime = "nodejs";

// Per-user searches/day: DAILY_SEARCH_LIMIT (lib/api-guard — shared with the MCP search tool, which
// draws from the SAME bucket). Over it → 429. Empty/whitespace queries short-circuit to [] and do
// NOT consume quota (they never reach the Worker).
//
// The proxy→Worker round trip has a hard WORKER_SEARCH_TIMEOUT_MS ceiling (lib/server/search-
// upstream): a hung Worker can't hold this function open to maxDuration. On timeout the fetch
// aborts and surfaces as the generic 502 below — fail fast, don't leak.

type SearchBody = {
  query?: unknown;
  precision?: unknown;
  rewrites?: unknown;
  limit?: unknown;
};

export async function POST(request: NextRequest) {
  // 1. Session gate — same DB-backed lookup as app/page.tsx (T3). No session → 401.
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  let body: SearchBody;
  try {
    body = (await request.json()) as SearchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { query, precision, rewrites, limit } = body;

  // 2. Empty/whitespace query → empty results, WITHOUT touching quota. Mirrors the Worker's own
  //    empty-query short-circuit so the client contract is unchanged for a cleared search box.
  if (typeof query !== "string" || !query.trim()) {
    return NextResponse.json({ results: [] });
  }

  // 3. Atomic per-user daily quota (shared helper). Increments today's counter BEFORE the
  //    forward, so a blocked (over-limit) request never reaches the Worker; a rare Worker/network
  //    failure below still consumes one unit of quota (acceptable). A quota-DB failure returns a
  //    clean JSON 500 (never a framework stack); over-limit returns a 429 { code: "search_quota" }
  //    the UI localizes. A DB error here means the search never runs — fail closed on the counter.
  const overLimit = await enforceQuota(gate.userId, "search", DAILY_SEARCH_LIMIT);
  if (overLimit) return overLimit;

  // 4. Forward to the Worker with the shared secret. The endpoint + secret are server-only.
  const worker = getWorkerConfig();
  if (!worker) {
    return NextResponse.json({ error: "search misconfigured" }, { status: 500 });
  }

  try {
    // T7 M1: the INCOMING request signal is composed with the timeout, so an abandoned/superseded
    // client search actually cancels the billable Workers-AI call upstream (the whole cost
    // rationale of the proxy lockdown). Either firing rejects → the catch below returns the 502.
    const { status, data } = await forwardWorkerSearch(worker, { query, precision, rewrites, limit }, request.signal);
    // Pass the Worker's JSON body + status through unchanged (the client depends on the exact
    // { results, phase } shape). A non-JSON body from the Worker is treated as a bad gateway.
    if (data === null) {
      return NextResponse.json({ error: "bad gateway" }, { status: 502 });
    }
    return NextResponse.json(data, { status });
  } catch {
    // Network error / Worker unreachable → generic 502 (don't leak the endpoint or internals).
    return NextResponse.json({ error: "search upstream failed" }, { status: 502 });
  }
}
