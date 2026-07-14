# Search Relevance Upgrade Plan

Upgrade the bookmark app's search stack — embeddings, hybrid retrieval, filtering, digest, and chat grounding — for markedly better relevance, including Hungarian queries and X Article content.

**Status:** proposed · **Scope:** this repo (+ one `xrelay` data backfill) · **Data:** 5,370 bookmarks, 186 X Articles

---

## Constraints (non-negotiable)

This is a **static Next.js app on Vercel**. The architecture that must survive:

- Bookmarks + search index are **static JSON** in `public/data/`, fetched and parsed in a Web Worker.
- **All retrieval runs in the browser** — Lunr keyword index built client-side, query embeddings computed client-side via Transformers.js, brute-force dot product over the int8 index. No database, no server-side vector search, no runtime infra.
- Server API routes exist **only** for passkey-gated AI calls (`/api/digest`, `/api/chat`, and one new `/api/expand`), all via OpenRouter.
- Deploys stay `git push → Vercel`. Index rebuilds happen locally via npm scripts, committed as data.

## Discovered data gap (changes the plan)

All 186 article bookmarks have `article.markdown: ""` — **article bodies were never captured**, neither by twitter-cli (legacy `articleText` was always empty) nor by `xrelay archive bookmarks`. Search currently sees only article *titles*. Fixing this is Phase 0 and is a prerequisite for the article-related work in Phase 2.

---

## Decision point: embedding model

The single biggest relevance lever. Two viable paths:

| | **Path A — `Xenova/multilingual-e5-small`** (recommended) | Path B — keep MiniLM + LLM query rewrite |
|---|---|---|
| Hungarian queries | Native (100-language model) | Via `/api/expand` translating HU→EN (needs unlock + network) |
| Retrieval tuning | Yes (`query:`/`passage:` asymmetric prefixes) | No (symmetric similarity model) |
| Dimensions | 384 — **index size unchanged** | 384 |
| Browser model download | ~112 MB quantized, one-time (Cache API); vs ~23 MB today | ~23 MB (unchanged) |
| Re-embed required | Yes, full rebuild | No |
| Offline HU search | Yes | No |

**Recommendation: Path A.** The download is one-time and cached; retrieval-tuned asymmetric embeddings improve *English* relevance too, not just HU. Mitigations for the download in T1.4. Path B remains the documented fallback if the 112 MB proves unacceptable on mobile — Phase 3's `/api/expand` gives most of B for free anyway, so the fallback costs nothing extra to keep open.

---

## Phase 0 — Measurement + data backfill

> Do this first: without an eval set, every later change is vibes.

### T0.1 Golden-query eval harness
- **New:** `scripts/eval-search.mjs` + `scripts/eval-queries.json`
- ~25–30 golden queries (mix: EN topical, HU topical, literal handles, article titles, multi-word phrases), each listing 1–5 known-relevant bookmark ids.
- Harness runs the exact production pipeline (import from `scripts/lib/` + a node port of the hybrid merge) and reports **Recall@10, MRR@10, nDCG@10** per query class, plus result-count sanity (broad-mode tail size).
- Run against the current stack first → baseline numbers committed into the file's header comment.
- **Accept:** `node scripts/eval-search.mjs` prints a comparable scorecard.

### T0.2 Backfill article bodies (xrelay)
- Script `scripts/backfill-articles.mjs`: for each bookmark with `article.title` and empty `article.markdown`, extract the article id from `urls` (`x.com/i/article/<id>`) or tweet id, run `xrelay article <id>` (serialized, 2–5 s gaps — 186 calls ≈ 15 min), write markdown into the archive file.
- Idempotent: skips non-empty markdown; safe to re-run for failures.
- **Also:** file an xrelay issue/task — `archive bookmarks` should optionally hydrate article bodies (`--articles` flag) so future syncs capture them natively. Until then, add the backfill script to the end of `npm run sync`.
- **Accept:** ≥ 90% of the 186 articles have non-empty markdown; `npm run sync` leaves no new empty-article entries.

---

## Phase 1 — Retrieval core (one index rebuild)

### T1.1 Model swap → `multilingual-e5-small` with prefixes
- `scripts/lib/embed.mjs`: `EMBED_MODEL = "Xenova/multilingual-e5-small"`; export `passageText(post)` that returns `"passage: " + searchText(post)`; bump index `schema_version` to `"2.0"` and record `prefix_scheme: "e5"`.
- `components/bookmarks-app.tsx` `embedQueries()`: prepend `"query: "` to every query string when `index.model` is an e5 model (key off a new index field, not a hardcode — old cached index must keep working during rollout).
- `lib/bookmark-search.ts` `SearchIndexPayload`: add optional `prefix_scheme`.
- **Accept:** eval scorecard ≥ baseline on EN, large win on HU class; full rebuild via `npm run build:search` (~5,556 vectors incl. T2.1 chunks if batched together — see Rollout).

### T1.2 Keyword index parity — article body + quoted text
- `lib/bookmark-search.ts` `buildKeywordIndex()`: add fields `article` (markdown, truncated ~2,000 chars, boost 3) and `quoted` (quoted tweet text + author, boost 2).
- **Accept:** a literal phrase that appears only in an article body or quoted tweet ranks top-10 in exact mode (add such a case to eval-queries).

### T1.3 Broad-mode relevance floor — honest counts, no junk tail
- Note score scale: doc vectors are int8 (`×127`), query vectors float → `dotProduct ≈ 127 × cosine`. e5 has a compressed cosine range (~0.7–0.9), so **calibrate, don't guess**: use the eval harness to pick an absolute cosine floor (start near 0.80 for e5) applied to vector results *before* RRF merge, plus a relative floor on merged broad results (`applyRelativeFloor(merged, ~0.3)` — value from calibration).
- Expose the constants in `bookmark-search.ts` with a comment linking to the eval run that set them.
- **Accept:** broad query result counts drop from ~900 to a defensible set with no recall loss on eval queries; status-line count becomes meaningful.

### T1.4 Model-download UX
- First semantic search now downloads ~112 MB (one-time, cached). Add a distinct status key (`status.modelDownloading`) with a progress callback from Transformers.js, and warm the model on idle (`requestIdleCallback` after the index JSON arrives) so the download usually finishes before the first query.
- **Accept:** cold first search shows download progress instead of a silent multi-second stall; second search is instant.

## Phase 2 — Article-aware index (same rebuild as Phase 1 if possible)

### T2.1 Chunked article embeddings (index schema v2)
- Long markdown exceeds the model's 512-token window — embed **chunks**: split article markdown into ~200-word chunks (title prepended to each), items become `{ id, part?, embedding }` (part omitted for the main tweet-text vector; `part: n` for article chunks).
- `vectorSearch`/`multiVectorSearch`: score per item, then **group by id with max-pooling** before ranking; `embed-new.mjs` dedupe stays id-based (any part present → skip).
- Estimated growth: 186 articles × ~1–5 chunks — index stays well under a MB of extra int8 data.
- **Accept:** an eval query answerable only from a mid-article paragraph retrieves that bookmark top-10.

### T2.2 Embed-text cleanup
- `searchText`: drop raw URLs (keep registrable domain only, e.g. `github.com`); everything else unchanged. Rides the same rebuild.
- **Accept:** no eval regression; `t.co` noise gone from passage text.

### T2.3 Digest sees article content
- `lib/digest-source.ts`: add `articleExcerpt` (~500 chars of markdown) to `DigestSource` when present; thread through `digest-schema.ts` (optional field) and `digest-prompt.ts` line builder. 60-source cap still fits nano's context comfortably.
- **Accept:** digest gists for article bookmarks reference body content, not just the title.

## Phase 3 — Smarter queries + sharper top-k (no rebuild)

### T3.1 LLM query expansion via `/api/expand`
- New route, same cookie gate + OpenRouter model as digest: input `{ query, language }` → output `{ rewrites: string[] }` (≤3: EN translation if query is HU, one synonym-rich rephrase, one narrowed variant). ~200 ms, fractions of a cent.
- Client: in **broad mode only**, when unlocked, call `/api/expand` alongside the static `QUERY_EXPANSIONS` (keep the dictionary as the offline/locked fallback); merge rewrites into `expandSemanticQueries` output (cap 8 total). Debounced-query keyed cache in memory so repeat searches don't re-call.
- **Accept:** HU eval queries match EN-language bookmarks even on Path B; paraphrase-style queries ("posts about making agents remember things") hit memory/context bookmarks.

### T3.2 Cross-encoder rerank of top-k
- Lazy-load `Xenova/ms-marco-MiniLM-L-6-v2` (~23 MB) on first search; rerank the **top 50** hybrid results against the raw query; blend `0.6 × rerank + 0.4 × hybrid-rank-score`. Skip silently if the model fails to load.
- This sharpens exactly what the AI features consume: digest top-30, chat context top-20.
- Note: cross-encoder is English-tuned — run it on the expanded/translated query from T3.1 when the original is HU.
- **Accept:** MRR@10 improves on eval; visual spot-check that near-duplicate spam drops below canonical sources.

## Phase 4 — Filtering & UX (independent, anytime)

### T4.1 Query operators
- Parse `from:handle`, `before:YYYY-MM[-DD]`, `after:YYYY-MM[-DD]` out of the query string (new `lib/query-operators.ts`, unit-tested); apply as hard filters on the scoped pool; the residual text goes to hybrid search. Show active operators as removable chips under the search box.
- **Accept:** `from:simonw after:2026-03 agents` returns only matching posts.

### T4.2 Sort-within-results
- `bookmarks-app.tsx:296` currently locks search results to score order. Add a "Relevance" option to the sort select (default during search); other sorts reorder *within* the matched set.
- **Accept:** searching + "Newest" shows newest matches first.

### T4.3 Nits
- `/api/chat` system prompt "~4,600 saved posts" → derive from `context.sources`/payload count sent by the client.
- Single-source `searchText`: `lib/bookmark-search.ts` re-exports from `scripts/lib/embed.mjs` (webpack imports `.mjs` fine) — removes the current drift (`"\n"` join vs whitespace-collapsed).
- Log (dev-only) the swallowed embedding error at `bookmarks-app.tsx:268`.
- Update `README.md` (model name, sync steps incl. article backfill, new scripts).

---

## Index schema v2 (summary)

```jsonc
{
  "schema_version": "2.0",
  "model": "Xenova/multilingual-e5-small",
  "prefix_scheme": "e5",              // client prepends "query: " when present
  "dimensions": 384,
  "encoding": "int8_normalized",
  "count": 5370,                       // unique bookmark ids (not vector count)
  "items": [
    { "id": "…", "embedding": [/* 384 int8 */] },            // tweet text vector
    { "id": "…", "part": 1, "embedding": [/* … */] }          // article chunk vectors
  ]
}
```

Client stays backward-compatible with v1 (no `prefix_scheme` → no query prefix; no `part` → no grouping needed).

## Rollout

1. **Phase 0** lands alone: backfill commits new archive data; eval harness records the baseline. Deployable immediately (search behavior unchanged, articles render bodies as a bonus).
2. **Phases 1+2 land together in one PR** — they share the single full re-embed (`npm run build:search`, ~20–30 min local CPU for ~5.5k vectors). Eval scorecard before/after goes in the PR description.
3. **Phase 3** two independent PRs (expand route; reranker).
4. **Phase 4** piecemeal.

Each phase: `npm run build` green + eval scorecard ≥ previous phase before push (per-repo verify).

## Risks

| Risk | Mitigation |
|---|---|
| 112 MB model download on mobile | Idle-time warmup, progress UI, Cache API persistence; documented fallback to Path B (keep MiniLM, lean on `/api/expand` translation) |
| e5 floor miscalibrated → hidden recall loss | Floors set only from eval-harness sweeps, constants documented; relative floor as backstop |
| Article backfill hits X rate limits | Serialized with jittered gaps, idempotent resume; partial success acceptable (re-run) |
| Chunked index breaks incremental `embed-new.mjs` | Id-based dedupe retained; unit test: sync after rebuild embeds only genuinely new posts |
| Cross-encoder latency on low-end devices | Rerank capped at top-50, lazy-loaded, silent skip on failure |
| Old cached `search-index.json` + new client (or vice versa) | v1/v2 both supported by the client; version-keyed behavior, no hard cutover |
