// Cloudflare search Worker (T2). Server-side semantic + rerank pipeline over the bge-m3
// index, mirroring the client pipeline in components/bookmarks-app.tsx but with the model
// calls swapped to the Workers AI bindings. Ranking math is REUSED from lib/* (one source of
// truth — run.md), never reimplemented here.
//
//   POST /search  { query, precision:"exact"|"broad", rewrites?: string[], limit?: number }
//              -> { results: [{ id, score }], phase: "reranked" }
//   OPTIONS /search -> CORS preflight
//   POST /embed  -> batch bge-m3 embeddings (kept from the T0/T1 spike; used by embed-bge.mjs)
//
// Pipeline is the FULL hybrid: keyword (lunr) ⊕ semantic (bge-m3) merged via the shared
// runHybridPipeline (RRF, tuned 0.6/0.4 exact / 0.35/0.65 broad) + rerank (bge-reranker-base).
// T3's semantic-only variant lost the keyword-dependent classes (handle, article-title) vs the
// e5-hybrid baseline; T3b restores keyword (T1 serialized public/data/lunr-index.json) and
// re-runs the gate. Ranking math is REUSED from lib/* — never reimplemented here.

import lunr from "lunr";
import {
  expandSemanticQueries,
  keywordSearch,
  multiVectorSearch,
  runHybridPipeline,
  type SearchIndexPayload,
  type SearchPrecision,
  type SearchResult,
} from "@/lib/bookmark-search";
import { RERANK_WINDOW, blendRerankScores, type RerankCandidate } from "@/lib/rerank-core";

// --- Minimal ambient types (worker has no @cloudflare/workers-types installed) -------------
interface R2ObjectBody {
  arrayBuffer(): Promise<ArrayBuffer>;
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
  // Present on both a real R2 object and the dev HTTP-fallback Response, so /archive
  // can stream the raw bookmark archive through without buffering it into memory.
  body: ReadableStream | null;
  // Quoted ETag (R2 objects only; undefined on the dev HTTP-fallback Response).
  httpEtag?: string;
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
  head(key: string): Promise<{ httpEtag: string } | null>;
}
interface Env {
  AI: { run: (model: string, input: unknown) => Promise<any> };
  // DEV: base URL of a static server exposing public/data (e.g. http://localhost:8080/data).
  DATA_BASE_URL?: string;
  // PROD (T8): private R2 bucket holding the packed index + rerank docs + lunr index AND the raw
  // bookmark archive (all-bookmarks.json, served by /archive). fetchAsset() prefers this over
  // DATA_BASE_URL when present; an R2 miss falls back to DATA_BASE_URL only in dev (see fetchAsset).
  // This is the T8 lockdown: none of the data is publicly downloadable from Vercel anymore.
  SEARCH_DATA?: R2Bucket;
  // Shared secret gating /search (T4). The browser no longer calls the Worker directly — an
  // authenticated Vercel proxy (app/api/search) is the ONLY caller, forwarding this secret in
  // the `X-Proxy-Secret` header. Unset OR a mismatched header → /search returns 401, so the
  // billable bge-m3 + reranker pipeline can't be hit directly. Set for prod via `wrangler secret
  // put SEARCH_PROXY_SECRET`; local `wrangler dev` reads it from worker/.dev.vars.
  SEARCH_PROXY_SECRET?: string;
  // Shared secret gating the billable /embed route. /embed is a dev-only tool (the bge-m3
  // re-embed job runs it via `wrangler dev`); on the deployed Worker it must NOT be a public
  // billable endpoint. Unset -> /embed is disabled (403). Set -> callers must send a matching
  // `X-Embed-Secret` header. /search stays public (search is for all visitors).
  EMBED_SECRET?: string;
}

// ============================ Data loading (per isolate, versioned) ========================
// Cached in module scope behind a single in-flight promise: the first request triggers the load,
// concurrent requests await the same promise. Swappable prod source = R2 (T5); DEV = HTTP.
//
// Versioned publish (scripts/upload-r2.mjs): the four search files live under `v/<version>/…` and
// `manifest.json` (written LAST) names the live version — so an isolate either sees the old set or
// the new set, never a half-uploaded mix (a new .meta with an old .bin used to be able to map
// vectors onto the wrong posts). Without a manifest (before the first versioned publish, or in
// dev) the legacy flat keys are read. Each isolate re-checks the manifest ETag at most once a
// minute and reloads when it changed, so new data goes live without waiting for isolate eviction.

type PackedMeta = {
  model: string;
  dimensions: number;
  count: number;
  vector_count: number;
  items: Array<{ id: string; part?: number }>;
};
type LoadedData = {
  index: SearchIndexPayload;
  rerankDocs: Record<string, string>;
  keywordIndex: lunr.Index;
};

type Manifest = { version: string; files: Record<string, string> };
type DataCache = { data: LoadedData; version: string; manifestEtag: string | null; checkedAt: number };

const MANIFEST_KEY = "manifest.json";
const MANIFEST_RECHECK_MS = 60_000;
let dataCache: DataCache | null = null;
let dataPromise: Promise<DataCache> | null = null;

async function fetchAsset(env: Env, name: string): Promise<R2ObjectBody> {
  if (env.SEARCH_DATA) {
    const obj = await env.SEARCH_DATA.get(name);
    if (obj) return obj;
    // R2 miss. In PROD there is no DATA_BASE_URL (removed from wrangler.jsonc at the T8 lockdown),
    // so a genuinely-missing object is a hard, visible error. In local `wrangler dev` the bound
    // bucket is an EMPTY local simulation, so every get() misses — fall through to the HTTP dev
    // server (DATA_BASE_URL in worker/.dev.vars) instead of failing, keeping eval/dev offline-friendly.
    if (!env.DATA_BASE_URL) throw new Error(`R2 object not found: ${name}`);
  }
  const base = env.DATA_BASE_URL ?? "http://localhost:8080/data";
  const res = await fetch(`${base}/${name}`);
  if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`);
  return res as unknown as R2ObjectBody;
}

async function loadData(env: Env, key: (name: string) => string): Promise<LoadedData> {
  const [meta, binBuf, rerankDocs, lunrJson] = await Promise.all([
    fetchAsset(env, key("search-index-bge.meta.json")).then((a) => a.json<PackedMeta>()),
    fetchAsset(env, key("search-index-bge.bin")).then((a) => a.arrayBuffer()),
    fetchAsset(env, key("rerank-docs.json")).then((a) => a.json<Record<string, string>>()),
    // Serialized lunr keyword index (T1, build-lunr-index.mjs), same field/boost config as
    // lib buildKeywordIndex. ~13MB parsed lazily on the FIRST request per isolate (NOT at
    // module top-level), so it stays out of the startup phase — see `wrangler check startup`.
    fetchAsset(env, key("lunr-index.json")).then((a) => a.json<object>()),
  ]);

  const int8 = new Int8Array(binBuf);
  const dim = meta.dimensions;
  if (int8.length !== meta.vector_count * dim) {
    throw new Error(`bin size ${int8.length} != ${meta.vector_count} × ${dim}`);
  }

  // Each item's embedding is a zero-copy Int8Array view into the shared buffer. lib's
  // dotProduct(queryFloat, itemInt8) reads a[i]*b[i] over these views — no per-request
  // materialization of 6,840 number[] arrays. int8 values are the on-disk normalized-float ×
  // 127 encoding, so dot ≈ 127 × cosine, matching lib INT8_VECTOR_SCALE (bookmark-search.ts).
  const items = meta.items.map((m, r) => ({
    id: m.id,
    part: m.part,
    embedding: int8.subarray(r * dim, (r + 1) * dim) as unknown as number[],
  }));

  const index: SearchIndexPayload = {
    ok: true,
    schema_version: "3.0",
    model: meta.model,
    dimensions: dim,
    encoding: "int8_normalized",
    count: meta.count,
    vector_count: meta.vector_count,
    items,
    // NO prefix_scheme: bge-m3 is prefix-free (spike-findings). runHybridPipeline keys its
    // bge broad-mode floors off model === "@cf/baai/bge-m3" (T3), so they ARE active here.
  };

  // Deserialize the lunr index once per isolate (lunr.Index.load takes the parsed JSON object).
  const keywordIndex = lunr.Index.load(lunrJson);

  return { index, rerankDocs, keywordIndex };
}

async function loadVersioned(env: Env): Promise<DataCache> {
  let manifest: Manifest | null = null;
  let manifestEtag: string | null = null;
  if (env.SEARCH_DATA) {
    const obj = await env.SEARCH_DATA.get(MANIFEST_KEY);
    if (obj) {
      manifest = await obj.json<Manifest>();
      manifestEtag = obj.httpEtag ?? null;
    }
  }
  const data = await loadData(env, (name) => manifest?.files?.[name] ?? name);
  return { data, version: manifest?.version ?? "legacy", manifestEtag, checkedAt: Date.now() };
}

async function initData(env: Env): Promise<DataCache> {
  // At most once a minute per isolate, a metadata-only head() of the manifest (one R2 round trip,
  // on the request path so THIS request already gets fresh data — with one user and long idle gaps,
  // a background check would hand the first search after a publish the old data). Changed → drop
  // the old set FIRST (rather than holding two copies in memory) and reload.
  if (dataCache && env.SEARCH_DATA && Date.now() - dataCache.checkedAt > MANIFEST_RECHECK_MS) {
    dataCache.checkedAt = Date.now();
    try {
      const head = await env.SEARCH_DATA.head(MANIFEST_KEY);
      if ((head?.httpEtag ?? null) !== dataCache.manifestEtag) dataCache = null;
    } catch {
      // R2 blip: keep serving the cached set; the next check is a minute away.
    }
  }
  if (dataCache) return dataCache;
  // `??=` alone would memoize a REJECTED promise forever (a transient R2/dev-server blip on the
  // first request would 500 every subsequent /search until the isolate is evicted). On failure,
  // reset dataPromise to null so the NEXT request retries a fresh load; concurrent requests share
  // the one in-flight promise.
  if (!dataPromise) {
    dataPromise = loadVersioned(env)
      .then((cache) => {
        dataCache = cache;
        return cache;
      })
      .finally(() => {
        dataPromise = null;
      });
  }
  return dataPromise;
}

// Remove unpaired UTF-16 surrogates (valid emoji pairs preserved). Workers AI hard-errors
// ("3030"/"3043 internal server error") on any input carrying lone surrogates — a class of
// malformed archive data T1 hit in the embed pipeline. rerank-docs.json still contains 2 such
// docs, so the reranker batch dies deterministically whenever one lands in a window; sanitize
// every string fed to env.AI.run defensively (also covers odd query text). See also the
// source-side fix in scripts/build-rerank-docs.mjs.
function stripLoneSurrogates(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

// ==================================== Query assembly =======================================
// Mirrors components/bookmarks-app.tsx's local mergeExpansions (query assembly, not ranking
// math): dedupe (trim+lowercase key) preserving order, cap at 8.
function mergeExpansions(staticExpansions: string[], rewrites: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const candidate of [...staticExpansions, ...rewrites]) {
    const key = candidate.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged.slice(0, 8);
}

// Workers AI intermittently returns transient 3043/3030 "internal server error"s (documented in
// T1's re-embed run) — the same error class on both the embed (@cf/baai/bge-m3) and rerank
// (@cf/baai/bge-reranker-base) bindings. Shared bounded retry-with-jitter so both call sites use
// ONE implementation (no drift). Callers decide what to do on exhaustion (rerank falls back to
// hybrid order; embed lets the error propagate to the request's generic 500).
const AI_RETRY_MAX_ATTEMPTS = 3;
async function retryTransientAI<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= AI_RETRY_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === AI_RETRY_MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt + Math.random() * 200));
    }
  }
  // Unreachable (loop above always returns or throws on the last attempt), but keeps TS happy.
  throw new Error("retryTransientAI: exhausted attempts");
}

// ======================================== Rerank ===========================================
// One independent scoring pass per request (NO module-level scheduler — lib/rerank.ts's
// latest-wins coalescer is for a single-user UI and would let concurrent requests supersede
// each other server-side). Reuses lib/rerank-core.ts's blendRerankScores for the exact blend.
async function rerankWindow(
  env: Env,
  results: SearchResult[],
  rerankDocs: Record<string, string>,
  rerankQuery: string,
): Promise<RerankCandidate[]> {
  const window = results.slice(0, RERANK_WINDOW);
  const tail = results.slice(RERANK_WINDOW);
  if (!rerankQuery.trim() || window.length < 2) return results;

  const contexts = window.map((r) => ({ text: stripLoneSurrogates(rerankDocs[r.id] ?? "") }));
  const safeQuery = stripLoneSurrogates(rerankQuery);

  // A 50-context rerank is < 1 neuron and fast, so retry with jitter before giving up. On
  // persistent failure fall back to the hybrid order (silent-skip contract, mirrors
  // lib/rerank.ts) rather than erroring the whole request.
  try {
    const rr = await retryTransientAI(() => env.AI.run("@cf/baai/bge-reranker-base", { query: safeQuery, contexts }));
    // response: [{ id: <original context index>, score: 0..1 }] sorted desc (spike-findings).
    const resp: Array<{ id: number; score: number }> = rr?.response ?? [];
    const ceScores = new Array(window.length).fill(0);
    for (const { id, score } of resp) {
      if (Number.isInteger(id) && id >= 0 && id < ceScores.length) ceScores[id] = score;
    }
    const blended = blendRerankScores(window, ceScores);
    return [...blended, ...tail];
  } catch {
    return results;
  }
}

// ========================================= CORS ============================================
// T4: /search is now called ONLY server-to-server by the Vercel proxy (app/api/search), never
// from a browser, so no cross-origin reflection is needed — the X-Proxy-Secret check is the
// real gate. A minimal static header set is kept only so a stray browser OPTIONS/POST still
// gets a sane, harmless response.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Proxy-Secret",
};

function json(body: unknown, status: number, cors: Record<string, string> = CORS_HEADERS): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}

// ======================================== Handler ==========================================
type SearchBody = {
  query?: unknown;
  precision?: unknown;
  rewrites?: unknown;
  limit?: unknown;
};

const DEFAULT_LIMIT = 240;

async function handleSearch(request: Request, env: Env): Promise<Response> {
  // T4 gate: only the authenticated Vercel proxy may reach the billable pipeline. It forwards a
  // server-only shared secret; a missing secret binding or a mismatched header → 401. This is
  // the real lockdown (the CORS simplification above is not a security control). Constant string
  // compare is acceptable here: the secret is high-entropy and never returned to the caller.
  if (!env.SEARCH_PROXY_SECRET || request.headers.get("X-Proxy-Secret") !== env.SEARCH_PROXY_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  let body: SearchBody;
  try {
    body = (await request.json()) as SearchBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { query, precision } = body;
  if (typeof query !== "string" || (precision !== "exact" && precision !== "broad")) {
    return json({ error: 'body must be { query: string, precision: "exact"|"broad" }' }, 400);
  }
  const prec = precision as SearchPrecision;
  const q = query.trim();
  if (!q) return json({ results: [] }, 200); // empty query -> empty results, not an error

  const rewrites =
    Array.isArray(body.rewrites) ? body.rewrites.filter((r): r is string => typeof r === "string" && r.trim().length > 0) : [];
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : DEFAULT_LIMIT;

  try {
    const loaded = await initData(env);
    const { index, rerankDocs, keywordIndex } = loaded.data;

    // 1. Static synonym expansions (lib) + LLM rewrites -> the set of query strings to embed.
    //    exact -> [normalized query]; broad -> up to 8 synonym-expanded variants.
    const staticExpansions = expandSemanticQueries(q, prec);
    const expandedQueries = mergeExpansions(staticExpansions, rewrites);
    if (!expandedQueries.length) return json({ results: [] }, 200);

    // 2. Embed all query variants — RAW text, no prefix (bge-m3), truncate oversized inputs.
    //    Strip lone surrogates so odd query text can't hard-error the embed call. Same transient
    //    3030/3043 error class as the reranker (I2), so retry with the same shared helper —
    //    unlike rerank there's no fallback to degrade to, so exhaustion propagates to the
    //    request's catch block below.
    const emb = await retryTransientAI(() =>
      env.AI.run("@cf/baai/bge-m3", {
        text: expandedQueries.map(stripLoneSurrogates),
        truncate_inputs: true,
      }),
    );
    const embeddings: number[][] = emb?.data ?? emb;

    // 3. Keyword (lunr) + vector search, merged by the shared hybrid pipeline — REUSED verbatim
    //    from lib/bookmark-search.ts (max-pool per id across query embeddings AND chunk parts,
    //    then RRF-merge keyword ⊕ vector with the tuned per-precision weights). Keyword search
    //    uses the RAW query (operators stripped client-side), mirroring the client (bookmarks-
    //    app.tsx keywordSearch(index, q)); embed uses the expanded/rewritten variants.
    //    runHybridPipeline's bge broad-mode floors (BGE_BROAD_VECTOR_COSINE_FLOOR / _MERGED_
    //    RELATIVE_FLOOR, keyed off model === "@cf/baai/bge-m3", re-swept for the hybrid tail in
    //    T3b) apply here; exact mode keeps its model-independent 0.5 relative floor.
    const keywordResults = keywordSearch(keywordIndex, q);
    const pooledVectorResults = multiVectorSearch(index, embeddings);
    // Task 2 (handle recall recovery): a bare single-token exact query (e.g. "rauchg",
    // "mattpocockuk") is the one class that regressed vs the old e5-hybrid baseline. Signal it
    // to runHybridPipeline so the bge-only, exact-only merge weighting can push exact-author
    // keyword hits into the top ranks / rerank window (see BGE_HANDLE_HYBRID_WEIGHTS in lib).
    // No-op for every other query shape (broad, multi-token exact) and for the e5 path.
    const bareHandle = prec === "exact" && q.split(/\s+/).filter(Boolean).length === 1;
    const finalHybrid = runHybridPipeline(keywordResults, pooledVectorResults, prec, index, { bareHandle });

    // 4. Rerank the top RERANK_WINDOW via bge-reranker-base; blend 0.6*ce + 0.4*hybrid.
    //    HU: rerank against rewrites[0] (the EN translation) if present, else the raw query.
    const rerankQuery = rewrites[0]?.trim() || q;
    const reranked = await rerankWindow(env, finalHybrid, rerankDocs, rerankQuery);

    // 5. Cap and return final reranked order (single round trip).
    const results = reranked.slice(0, limit).map((r) => ({ id: r.id, score: r.score }));
    // x-data-version lets the sync confirm a fresh publish is actually being served.
    return json({ results, phase: "reranked" }, 200, { ...CORS_HEADERS, "x-data-version": loaded.version });
  } catch (err) {
    // /search is public; don't echo internal detail (R2 keys, DATA_BASE_URL, bin-size mismatches)
    // to the client. Log server-side (Workers logs) and return a generic message instead.
    console.error("search failed:", err);
    return json({ error: "search failed" }, 500);
  }
}

// GET /archive — stream the raw bookmark archive (all-bookmarks.json) to the AUTHENTICATED
// Vercel proxy (app/api/archive), which the browser's data Web Worker calls to render the cards.
// Gated by the SAME X-Proxy-Secret as /search: before T8 this file was a public static asset at
// /data/all-bookmarks.json on Vercel — the user's entire private archive, downloadable by anyone
// with the URL. Now it lives only in private R2 and is reachable solely through this secret-gated
// endpoint behind a session-checked proxy. Streams the body through (no in-memory buffering) via
// the shared fetchAsset loader, so it transparently uses R2 in prod and the dev HTTP fallback locally.
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => strip(t) === strip(etag));
}

async function handleArchive(request: Request, env: Env): Promise<Response> {
  if (!env.SEARCH_PROXY_SECRET || request.headers.get("X-Proxy-Secret") !== env.SEARCH_PROXY_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    // Conditional GET: the browser caches the archive in IndexedDB and revalidates with
    // If-None-Match, so an unchanged archive (the daily sync changes it at most once a day) is a
    // metadata-only head() + 304 instead of streaming ~12 MB out of R2. Weak/strong forms compare
    // equal, since a compressing hop can weaken the tag on the way back.
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (ifNoneMatch && env.SEARCH_DATA) {
      const head = await env.SEARCH_DATA.head("all-bookmarks.json");
      if (head && etagMatches(ifNoneMatch, head.httpEtag)) {
        return new Response(null, { status: 304, headers: { etag: head.httpEtag, "cache-control": "private, no-cache" } });
      }
    }
    const obj = await fetchAsset(env, "all-bookmarks.json");
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // Revalidate every time; the browser-side cache is IndexedDB, keyed by this ETag.
      "cache-control": "private, no-cache",
    };
    if (obj.httpEtag) headers.etag = obj.httpEtag;
    return new Response(obj.body, { status: 200, headers });
  } catch (err) {
    // Don't leak R2 keys / DATA_BASE_URL / internal detail to the caller (mirrors handleSearch).
    console.error("archive failed:", err);
    return json({ error: "archive failed" }, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/search") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
      if (request.method === "POST") return handleSearch(request, env);
      return json({ error: "method not allowed" }, 405);
    }

    if (url.pathname === "/archive") {
      if (request.method === "GET") return handleArchive(request, env);
      return json({ error: "method not allowed" }, 405);
    }

    // POST /embed — batch bge-m3 embeddings for the re-embed pipeline (T1). Billable, so it
    // is gated behind EMBED_SECRET: disabled entirely unless the secret is set AND the caller
    // sends a matching X-Embed-Secret header. The deployed /search Worker leaves EMBED_SECRET
    // unset, so /embed is inert in prod; the re-embed job sets it in worker/.dev.vars.
    if (request.method === "POST" && url.pathname === "/embed") {
      if (!env.EMBED_SECRET || request.headers.get("X-Embed-Secret") !== env.EMBED_SECRET) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      try {
        const body = (await request.json()) as { texts?: unknown };
        const texts = body?.texts;
        if (!Array.isArray(texts) || !texts.every((t) => typeof t === "string")) {
          return Response.json({ error: "body must be { texts: string[] }" }, { status: 400 });
        }
        const result = await env.AI.run("@cf/baai/bge-m3", { text: texts, truncate_inputs: true });
        const vectors: number[][] = result?.data ?? result;
        return Response.json({ vectors });
      } catch (err) {
        console.error("embed failed:", err);
        return Response.json({ error: "embed failed" }, { status: 500 });
      }
    }

    return json({ ok: true, routes: ["POST /search", "OPTIONS /search", "GET /archive", "POST /embed"] }, 200);
  },
};
