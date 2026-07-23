// T0 spike: probe @cf/baai/bge-m3 (embeddings) and @cf/baai/bge-reranker-base (rerank)
// I/O shapes empirically. GET / returns a JSON summary; no secrets, throwaway.

interface Env {
  AI: {
    run: (model: string, input: unknown) => Promise<any>;
  };
}

function norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /embed — batch bge-m3 embeddings for the re-embed pipeline (Task 1).
    // Body: { texts: string[] } → { vectors: number[][] } (1024-dim, L2-normalized, RAW text).
    if (request.method === "POST" && url.pathname === "/embed") {
      try {
        const body = (await request.json()) as { texts?: unknown };
        const texts = body?.texts;
        if (!Array.isArray(texts) || !texts.every((t) => typeof t === "string")) {
          return Response.json({ error: "body must be { texts: string[] }" }, { status: 400 });
        }
        // truncate_inputs: bge-m3 otherwise hard-errors ("3030: invalid input") on any text
        // over its max sequence length; this truncates oversized inputs to the model max
        // instead (matching the e5/transformers.js pipeline's old silent 512-token truncation).
        const result = await env.AI.run("@cf/baai/bge-m3", { text: texts, truncate_inputs: true });
        const vectors: number[][] = result?.data ?? result;
        return Response.json({ vectors });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    const out: Record<string, unknown> = {};

    // --- bge-m3 embeddings ---
    try {
      const query = "query: hungarian agent workflows";
      const passage = "passage: How to build autonomous coding agents with tool use and memory.";
      const emb = await env.AI.run("@cf/baai/bge-m3", { text: [query, passage] });
      const vecs: number[][] = emb?.data ?? emb;
      out.bge_m3 = {
        rawTopLevelKeys: emb && typeof emb === "object" ? Object.keys(emb) : typeof emb,
        shape: emb?.shape ?? null,
        count: Array.isArray(vecs) ? vecs.length : null,
        dims: Array.isArray(vecs) && Array.isArray(vecs[0]) ? vecs[0].length : null,
        norms: Array.isArray(vecs) && Array.isArray(vecs[0]) ? vecs.map((v) => Number(norm(v).toFixed(4))) : null,
        first5_query: Array.isArray(vecs?.[0]) ? vecs[0].slice(0, 5) : null,
      };
    } catch (err) {
      out.bge_m3_error = String(err);
    }

    // --- bge-m3 WITHOUT explicit prefixes (does it need "query:"/"passage:"?) ---
    try {
      const emb = await env.AI.run("@cf/baai/bge-m3", { text: ["agent workflows"] });
      const vecs: number[][] = emb?.data ?? emb;
      out.bge_m3_noprefix = {
        dims: Array.isArray(vecs?.[0]) ? vecs[0].length : null,
        norm: Array.isArray(vecs?.[0]) ? Number(norm(vecs[0]).toFixed(4)) : null,
      };
    } catch (err) {
      out.bge_m3_noprefix_error = String(err);
    }

    // --- bge-reranker-base ---
    try {
      const rr = await env.AI.run("@cf/baai/bge-reranker-base", {
        query: "how to build coding agents",
        contexts: [
          { text: "A recipe for chocolate cake." },
          { text: "Building autonomous coding agents with tool use." },
          { text: "The weather in Budapest today." },
        ],
      });
      out.bge_reranker = {
        rawTopLevelKeys: rr && typeof rr === "object" ? Object.keys(rr) : typeof rr,
        raw: rr,
      };
    } catch (err) {
      out.bge_reranker_error = String(err);
    }

    // --- reranker with top_k ---
    try {
      const rr = await env.AI.run("@cf/baai/bge-reranker-base", {
        query: "coding agents",
        contexts: [{ text: "cats" }, { text: "coding agents with tools" }],
        top_k: 2,
      });
      out.bge_reranker_topk = rr;
    } catch (err) {
      out.bge_reranker_topk_error = String(err);
    }

    return new Response(JSON.stringify(out, null, 2), {
      headers: { "content-type": "application/json" },
    });
  },
};
