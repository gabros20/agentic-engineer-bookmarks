import { NextResponse } from "next/server";

import { requireUser } from "@/lib/api-guard";
import type { SyncStatus } from "@/lib/queries";

// When the bookmark sync last succeeded — the menu's "Synced 2 h ago" line, which turns into a
// warning when the Mac's sync autopilot has stopped (it once sat unloaded for days with nobody
// noticing: its own "no sync for 3 days" alert runs inside the agent that had stopped). Session-gated
// like /api/archive, then forwarded to the secret-gated Worker GET /sync-status, which reads the
// heartbeat the sync writes to R2 on every success. Only timestamps + a count come back.
export const runtime = "nodejs";

const WORKER_TIMEOUT_MS = 8000;

export async function GET(request: Request) {
  const gate = await requireUser();
  if (!gate.ok) return gate.response;

  const endpoint = process.env.SEARCH_ENDPOINT?.replace(/\/+$/, "");
  const secret = process.env.SEARCH_PROXY_SECRET;
  if (!endpoint || !secret) return NextResponse.json({ error: "sync status misconfigured" }, { status: 500 });

  try {
    const res = await fetch(`${endpoint}/sync-status`, {
      headers: { "X-Proxy-Secret": secret },
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(WORKER_TIMEOUT_MS)]),
      cache: "no-store",
    });
    if (!res.ok) return NextResponse.json({ error: "sync status upstream failed" }, { status: 502 });
    const body = (await res.json()) as Partial<SyncStatus>;
    const status: SyncStatus = {
      syncedAt: typeof body.syncedAt === "string" ? body.syncedAt : null,
      count: typeof body.count === "number" ? body.count : null,
      publishedAt: typeof body.publishedAt === "string" ? body.publishedAt : null,
    };
    return NextResponse.json(status, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "sync status upstream failed" }, { status: 502 });
  }
}
