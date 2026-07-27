import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/api-guard";

// Authenticated archive proxy (T8). The browser's data Web Worker (lib/data-worker.ts) fetches
// the raw bookmark archive here to render the cards. Before T8 it downloaded a PUBLIC static asset
// at /data/all-bookmarks.json on Vercel — the user's entire private archive, grabbable by anyone
// with the URL even though the UI is behind login. Now the file lives only in a private R2 bucket,
// reachable solely through the secret-gated Worker GET /archive, and this route session-gates the
// request first (no session → JSON 401) before forwarding with the server-only SEARCH_PROXY_SECRET.
// The Worker's body is streamed straight through (no buffering an 8-9 MB payload in the function).
//
// Unlike the AI routes there is NO per-user quota here: this is a once-per-page-load rendering
// fetch, not a billable model call, so a quota would just break normal browsing. The session gate
// (invite-only account required) is the control that keeps the archive private.
export const runtime = "nodejs";

// Hard ceiling on the proxy→Worker round trip, mirroring app/api/search. A hung Worker must not
// hold this Vercel function open to its maxDuration; on timeout the fetch aborts → generic 502.
const WORKER_TIMEOUT_MS = 15000;

export async function GET(request: NextRequest) {
  // 1. Session gate — same DB-backed lookup as the search/AI routes. No session → 401 (a JSON
  //    401 the Web Worker can handle, NOT an HTML /login redirect; /api/archive is allow-listed
  //    in proxy.ts so the optimistic wall doesn't bounce it).
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  // 2. Forward to the secret-gated Worker. Endpoint + secret are server-only (never NEXT_PUBLIC_*).
  const endpoint = process.env.SEARCH_ENDPOINT?.replace(/\/+$/, "");
  const secret = process.env.SEARCH_PROXY_SECRET;
  if (!endpoint || !secret) {
    return NextResponse.json({ error: "archive misconfigured" }, { status: 500 });
  }

  try {
    const res = await fetch(`${endpoint}/archive`, {
      method: "GET",
      headers: { "X-Proxy-Secret": secret },
      // Compose the timeout with the incoming request signal so an abandoned page-load actually
      // cancels the upstream R2 read instead of running to the ceiling (mirrors app/api/search).
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(WORKER_TIMEOUT_MS)]),
    });
    if (!res.ok || !res.body) {
      // Don't leak the endpoint or internals; the Worker already logged the real cause.
      return NextResponse.json({ error: "archive upstream failed" }, { status: 502 });
    }
    // Stream the JSON body straight through — do NOT buffer the whole archive into memory.
    return new NextResponse(res.body, {
      status: 200,
      headers: {
        "content-type": "application/json",
        // Same archive for every user; the session gate above re-runs on each request, so a short
        // private (per-browser) cache is safe and avoids re-fetching on reload/tab restore.
        "cache-control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "archive upstream failed" }, { status: 502 });
  }
}
