// Pure rerank blend math, extracted from lib/rerank.ts (T2 — the Cloudflare search Worker).
//
// The Worker (worker/src/index.ts) reranks server-side via the Workers AI
// `@cf/baai/bge-reranker-base` binding, so it needs the EXACT blend/normalize math but must
// NOT pull in lib/rerank.ts's `@huggingface/transformers` dynamic import (browser/Node-only,
// and irrelevant server-side). Extracting the pure functions here — with lib/rerank.ts and
// the Worker both importing them — keeps ONE source of truth for the rerank blend (run.md:
// "ONE source of truth for ranking keeps the eval valid"). Behavior is byte-identical to the
// pre-extraction inline blend, so the Node eval mirror (scripts/lib/search-core.mjs) stays
// valid without changes.

export const RERANK_WINDOW = 50;

const CE_BLEND_WEIGHT = 0.6;
const HYBRID_BLEND_WEIGHT = 0.4;

export type RerankCandidate = { id: string; score: number };

/**
 * Min-max normalize a score array into [0, 1]. Ties (max === min — including the
 * single-element and all-equal cases) collapse every entry to a neutral 0.5 rather than
 * arbitrarily boosting or zeroing them: with one side of the blend constant, ordering is
 * decided entirely by the other (still-differentiated) side. [Minor, reversible,
 * non-user-visible edge-case choice — noted here per the report contract, not escalated.]
 */
export function minMaxNormalize(values: number[]): number[] {
  if (!values.length) return values;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min < 1e-9) return values.map(() => 0.5);
  return values.map((v) => (v - min) / (max - min));
}

/**
 * Blend cross-encoder scores into the hybrid window. Min-max normalizes BOTH the raw
 * cross-encoder scores and the incoming hybrid scores over the window, blends
 * `CE_BLEND_WEIGHT * ce + HYBRID_BLEND_WEIGHT * hybrid`, and re-sorts the window desc.
 * `ceScoresRaw[i]` must correspond to `window[i]` (same order/length). Caller owns the
 * length check and appending any untouched tail (results beyond the window).
 */
export function blendRerankScores(window: RerankCandidate[], ceScoresRaw: number[]): RerankCandidate[] {
  const ceNorm = minMaxNormalize(ceScoresRaw);
  const hybridNorm = minMaxNormalize(window.map((r) => r.score));
  return window
    .map((r, i) => ({ id: r.id, score: CE_BLEND_WEIGHT * ceNorm[i] + HYBRID_BLEND_WEIGHT * hybridNorm[i] }))
    .sort((a, b) => b.score - a.score);
}
