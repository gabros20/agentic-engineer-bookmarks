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
// Default pipeline is semantic (bge-m3) + rerank (bge-reranker-base) ONLY — no keyword/lunr
// (see task-2-brief "Keyword decision"). T3 measures this against the e5-hybrid baseline.

import {
  expandSemanticQueries,
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
}
interface R2Bucket {
  get(key: string): Promise<R2ObjectBody | null>;
}
interface Env {
  AI: { run: (model: string, input: unknown) => Promise<any> };
  // DEV: base URL of a static server exposing public/data (e.g. http://localhost:8080/data).
  DATA_BASE_URL?: string;
  // PROD (T5, after R2 is enabled): bind the bucket holding the packed index + rerank docs.
  // loadData() prefers this over DATA_BASE_URL when present — the only swap needed at deploy.
  SEARCH_DATA?: R2Bucket;
  // Optional comma-separated extra allowed CORS origins (prod app origin, set in T5).
  ALLOWED_ORIGINS?: string;
  // Shared secret gating the billable /embed route. /embed is a dev-only tool (the bge-m3
  // re-embed job runs it via `wrangler dev`); on the deployed Worker it must NOT be a public
  // billable endpoint. Unset -> /embed is disabled (403). Set -> callers must send a matching
  // `X-Embed-Secret` header. /search stays public (search is for all visitors).
  EMBED_SECRET?: string;
}

// ============================ Data loading (once per isolate) ==============================
// Cached in module scope behind a single init promise: the first request triggers the load,
// concurrent requests await the same promise. Swappable prod source = R2 (T5); DEV = HTTP.

type PackedMeta = {
  model: string;
  dimensions: number;
  count: number;
  vector_count: number;
  items: Array<{ id: string; part?: number }>;
};
type LoadedData = { index: SearchIndexPayload; rerankDocs: Record<string, string> };

let dataPromise: Promise<LoadedData> | null = null;

async function fetchAsset(env: Env, name: string): Promise<R2ObjectBody> {
  if (env.SEARCH_DATA) {
    const obj = await env.SEARCH_DATA.get(name);
    if (!obj) throw new Error(`R2 object not found: ${name}`);
    return obj;
  }
  const base = env.DATA_BASE_URL ?? "http://localhost:8080/data";
  const res = await fetch(`${base}/${name}`);
  if (!res.ok) throw new Error(`fetch ${name} failed: ${res.status}`);
  return res as unknown as R2ObjectBody;
}

async function loadData(env: Env): Promise<LoadedData> {
  const [meta, binBuf, rerankDocs] = await Promise.all([
    fetchAsset(env, "search-index-bge.meta.json").then((a) => a.json<PackedMeta>()),
    fetchAsset(env, "search-index-bge.bin").then((a) => a.arrayBuffer()),
    fetchAsset(env, "rerank-docs.json").then((a) => a.json<Record<string, string>>()),
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
    // NO prefix_scheme: bge-m3 is prefix-free (spike-findings). This also keeps
    // runHybridPipeline's broad-mode floors INACTIVE — see the TODO(T3) at its call site.
  };

  return { index, rerankDocs };
}

function initData(env: Env): Promise<LoadedData> {
  return (dataPromise ??= loadData(env));
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

  // Workers AI intermittently returns transient 3043/3030 "internal server error"s
  // (documented in T1's re-embed run). A 50-context rerank is < 1 neuron and fast, so retry
  // with jitter before giving up. On persistent failure fall back to the hybrid order
  // (silent-skip contract, mirrors lib/rerank.ts) rather than erroring the whole request.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const rr = await env.AI.run("@cf/baai/bge-reranker-base", { query: safeQuery, contexts });
      // response: [{ id: <original context index>, score: 0..1 }] sorted desc (spike-findings).
      const resp: Array<{ id: number; score: number }> = rr?.response ?? [];
      const ceScores = new Array(window.length).fill(0);
      for (const { id, score } of resp) {
        if (Number.isInteger(id) && id >= 0 && id < ceScores.length) ceScores[id] = score;
      }
      const blended = blendRerankScores(window, ceScores);
      return [...blended, ...tail];
    } catch {
      if (attempt === MAX_ATTEMPTS) return results;
      await new Promise((resolve) => setTimeout(resolve, 150 * attempt + Math.random() * 200));
    }
  }
  return results;
}

// ========================================= CORS ============================================
function allowedOrigin(origin: string | null, env: Env): string | null {
  if (!origin) return null;
  const extra = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (extra.includes(origin)) return origin;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  if (/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return origin;
  // TODO(T5): pin the production Vercel app origin via ALLOWED_ORIGINS (or replace this regex).
  if (/^https:\/\/([a-z0-9-]+\.)*vercel\.app$/.test(origin)) return origin;
  return null;
}

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allow = allowedOrigin(origin, env);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
  if (allow) headers["Access-Control-Allow-Origin"] = allow;
  return headers;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
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

async function handleSearch(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: SearchBody;
  try {
    body = (await request.json()) as SearchBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400, cors);
  }

  const { query, precision } = body;
  if (typeof query !== "string" || (precision !== "exact" && precision !== "broad")) {
    return json({ error: 'body must be { query: string, precision: "exact"|"broad" }' }, 400, cors);
  }
  const prec = precision as SearchPrecision;
  const q = query.trim();
  if (!q) return json({ results: [] }, 200, cors); // empty query -> empty results, not an error

  const rewrites =
    Array.isArray(body.rewrites) ? body.rewrites.filter((r): r is string => typeof r === "string" && r.trim().length > 0) : [];
  const limit = typeof body.limit === "number" && body.limit > 0 ? Math.floor(body.limit) : DEFAULT_LIMIT;

  try {
    const { index, rerankDocs } = await initData(env);

    // 1. Static synonym expansions (lib) + LLM rewrites -> the set of query strings to embed.
    //    exact -> [normalized query]; broad -> up to 8 synonym-expanded variants.
    const staticExpansions = expandSemanticQueries(q, prec);
    const expandedQueries = mergeExpansions(staticExpansions, rewrites);
    if (!expandedQueries.length) return json({ results: [] }, 200, cors);

    // 2. Embed all query variants — RAW text, no prefix (bge-m3), truncate oversized inputs.
    //    Strip lone surrogates so odd query text can't hard-error the embed call.
    const emb = await env.AI.run("@cf/baai/bge-m3", {
      text: expandedQueries.map(stripLoneSurrogates),
      truncate_inputs: true,
    });
    const embeddings: number[][] = emb?.data ?? emb;

    // 3. Vector search + floors — REUSED verbatim from lib/bookmark-search.ts (max-pool group
    //    per id across query embeddings AND chunk parts, then the shared hybrid pipeline).
    //    Keyword side is empty ([]) — semantic-only default (see Keyword decision).
    //    TODO(T3): runHybridPipeline gates its broad-mode absolute+relative floors on
    //    index.prefix_scheme === "e5"; the bge index has none, so broad floors are currently
    //    INACTIVE. e5's BROAD_VECTOR_COSINE_FLOOR (0.82) is invalid for bge-m3 (cosines top
    //    ~0.67 per spike/T1) and would zero out results. T3 recalibrates the bge floors and
    //    wires them in. Exact mode's model-independent 0.5 relative floor still applies today.
    const pooledVectorResults = multiVectorSearch(index, embeddings);
    const finalHybrid = runHybridPipeline([], pooledVectorResults, prec, index);

    // 4. Rerank the top RERANK_WINDOW via bge-reranker-base; blend 0.6*ce + 0.4*hybrid.
    //    HU: rerank against rewrites[0] (the EN translation) if present, else the raw query.
    const rerankQuery = rewrites[0]?.trim() || q;
    const reranked = await rerankWindow(env, finalHybrid, rerankDocs, rerankQuery);

    // 5. Cap and return final reranked order (single round trip).
    const results = reranked.slice(0, limit).map((r) => ({ id: r.id, score: r.score }));
    return json({ results, phase: "reranked" }, 200, cors);
  } catch (err) {
    return json({ error: String(err) }, 500, cors);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env);

    if (url.pathname === "/search") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (request.method === "POST") return handleSearch(request, env, cors);
      return json({ error: "method not allowed" }, 405, cors);
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
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    return json({ ok: true, routes: ["POST /search", "OPTIONS /search", "POST /embed"] }, 200, cors);
  },
};
