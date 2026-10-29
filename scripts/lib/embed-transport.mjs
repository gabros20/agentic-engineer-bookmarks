// How embed-bge.mjs reaches bge-m3. Two transports, same contract — `embed(texts) → number[][]`:
//
//   rest  (default) Workers AI REST API with the sync's CLOUDFLARE_API_TOKEN:
//         POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/baai/bge-m3
//         No local server, no port, no secret. Same model + billing as the Worker's AI binding
//         (that binding was always remote, even under `wrangler dev`); vectors match the stored
//         index to cosine ≥ 0.9998 (int8 rounding).
//   local (fallback) the worker's POST /embed on a throwaway `wrangler dev` (scripts/sync-bge.mjs
//         starts it on a free port) — for a token without the Workers AI permission.
//
// Errors are classified so callers don't grind for hours on something retrying can't fix:
// FatalEmbedError (bad token/permission, wrong account, dead local server, malformed request) stops
// the run at once; everything else (429, 5xx, Workers AI's transient 3030/3043, timeouts) is
// retryable, with `retryAfterMs` when the server says how long to wait.

const MODEL = "@cf/baai/bge-m3";
const REQUEST_TIMEOUT_MS = 60_000;
const API = "https://api.cloudflare.com/client/v4";

export class FatalEmbedError extends Error {
  constructor(message) {
    super(message);
    this.name = "FatalEmbedError";
  }
}

export class RetryableEmbedError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = "RetryableEmbedError";
    this.retryAfterMs = retryAfterMs;
  }
}

// Workers AI error codes that mean "try again" even when the HTTP status is a 4xx.
const TRANSIENT_AI_CODES = new Set([3030, 3040, 3043, 3046]);

function retryAfterMs(res) {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(120_000, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(120_000, Math.max(0, date - Date.now())) : undefined;
}

function networkError(err, where) {
  // Connection refused = nothing listening (local server died): retrying the same URL can't help.
  if (err?.cause?.code === "ECONNREFUSED") return new FatalEmbedError(`${where} refused the connection (server not running)`);
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return new RetryableEmbedError(`${where} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
  return new RetryableEmbedError(`${where} network error: ${err?.cause?.code ?? err?.message ?? err}`);
}

function checkVectors(vectors, count) {
  if (!Array.isArray(vectors) || vectors.length !== count) {
    throw new RetryableEmbedError(`expected ${count} vectors, got ${Array.isArray(vectors) ? vectors.length : typeof vectors}`);
  }
  return vectors;
}

/** Workers AI REST transport. */
export function restTransport({ accountId, token }) {
  if (!accountId || !token) throw new FatalEmbedError("rest transport needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN");
  const url = `${API}/accounts/${accountId}/ai/run/${MODEL}`;
  return async function embed(texts) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text: texts, truncate_inputs: true }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(err, "Workers AI");
    }
    const body = await res.json().catch(() => null);
    if (res.ok && body?.success !== false) return checkVectors(body?.result?.data, texts.length);

    const errors = body?.errors ?? [];
    const detail = errors.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`;
    if (errors.some((e) => TRANSIENT_AI_CODES.has(Number(e.code))) || res.status === 429 || res.status >= 500) {
      throw new RetryableEmbedError(`Workers AI ${res.status} (${detail})`, retryAfterMs(res));
    }
    if (res.status === 401 || res.status === 403) {
      throw new FatalEmbedError(`Workers AI rejected the token (${res.status}: ${detail}) — it needs Account · Workers AI permission`);
    }
    throw new FatalEmbedError(`Workers AI ${res.status} (${detail})`);
  };
}

/** Local `wrangler dev` POST /embed transport (gated by EMBED_SECRET). */
export function localTransport({ url, secret }) {
  return async function embed(texts) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(secret ? { "X-Embed-Secret": secret } : {}) },
        body: JSON.stringify({ texts }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw networkError(err, `local /embed (${url})`);
    }
    const text = await res.text();
    if (res.ok) {
      const { vectors, error } = JSON.parse(text);
      if (error) throw new RetryableEmbedError(`worker error: ${error}`);
      return checkVectors(vectors, texts.length);
    }
    // The worker wraps every Workers AI failure (incl. transient 3030s) in a 500.
    if (res.status === 429 || res.status >= 500) throw new RetryableEmbedError(`local /embed ${res.status}: ${text.slice(0, 200)}`, retryAfterMs(res));
    throw new FatalEmbedError(`local /embed ${res.status}: ${text.slice(0, 200)}${res.status === 403 ? " (EMBED_SECRET mismatch with worker/.dev.vars)" : ""}`);
  };
}

/**
 * Which Cloudflare account to use: CLOUDFLARE_ACCOUNT_ID if set, else the token's only account.
 * Returns { accountId } or { error } (several accounts → must be pinned; none → token can't see any).
 */
export async function resolveAccountId(token, preset) {
  if (preset) return { accountId: preset };
  try {
    const res = await fetch(`${API}/accounts?per_page=50`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) return { error: `account lookup failed (HTTP ${res.status})` };
    const accounts = body.result ?? [];
    if (accounts.length === 1) return { accountId: accounts[0].id };
    if (!accounts.length) return { error: "the token can't see any Cloudflare account" };
    return { error: `the token sees ${accounts.length} accounts — pin one: npm run autosync -- install --account-id <id>` };
  } catch (err) {
    return { error: `account lookup failed: ${err?.cause?.code ?? err.message}` };
  }
}

/** One tiny embed to confirm the REST transport works with this token. Returns { ok } or { ok:false, fatal, error }. */
export async function probeRest({ accountId, token }) {
  try {
    const [vector] = await restTransport({ accountId, token })(["ping"]);
    if (vector?.length !== 1024) return { ok: false, fatal: true, error: `unexpected embedding size ${vector?.length}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, fatal: err instanceof FatalEmbedError, error: err.message };
  }
}
