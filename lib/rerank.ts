// Task 11 (T3.2): browser-side cross-encoder rerank of the top RERANK_WINDOW hybrid
// results. Lazily loads Xenova/ms-marco-MiniLM-L-6-v2 (~23 MB quantized onnx), scores the
// window as (query, passage) pairs, and blends the cross-encoder signal into the hybrid
// order. Silent-skip contract throughout: on ANY failure this returns the input order
// unchanged, never throws, never surfaces to the UI.
//
// API probe (read node_modules/@huggingface/transformers source + .d.ts, NOT memory —
// version 4.2.0 installed):
// - `pipeline("text-classification", ...)` does NOT support (query, passage) pairs.
//   TextClassificationPipeline._call (dist/transformers.js, "src/pipelines/
//   text-classification.js" section) calls `this.tokenizer(texts, { padding: true,
//   truncation: true })` — no `text_pair` is ever forwarded — so the high-level pipeline
//   API is a dead end for a cross-encoder. Confirmed by reading the transpiled source
//   directly (grep for "text_pair" only turns up zero-shot-classification and
//   question-answering pipelines, never text-classification).
// - The correct API is the lower-level `AutoTokenizer.from_pretrained` +
//   `AutoModelForSequenceClassification.from_pretrained`, used directly (not through
//   `pipeline()`). Verified by actually loading the real model in this repo (node -e probe,
//   documented in .orchestrate/task-11-report.md):
//     const tok = await AutoTokenizer.from_pretrained("Xenova/ms-marco-MiniLM-L-6-v2");
//     const model = await AutoModelForSequenceClassification.from_pretrained(
//       "Xenova/ms-marco-MiniLM-L-6-v2", { dtype: "q8" },
//     );
//     const inputs = tok(queries, { text_pair: passages, padding: true, truncation: true });
//     const { logits } = await model(inputs); // dims [batchSize, 1]
//   `tokenizer(texts, { text_pair, ... })` batches: text_pair must be an array of the same
//   length as `texts` when `texts` is an array (dist/transformers.js ~L15054-15087),
//   pairing texts[i] with text_pair[i] — so passing the same query repeated `window.length`
//   times alongside the per-item passages produces exactly the (query, passage) pairs we
//   need in one batched forward pass.
// - This cross-encoder's config has no `problem_type` and `id2label = { "0": "LABEL_0" }`
//   (a single-logit regression-style head, not the softmax/top-k classification path the
//   `text-classification` pipeline assumes) — `logits.dims` is `[batchSize, 1]`, one
//   unbounded relevance logit per pair. Verified empirically: a clearly relevant pair scored
//   logit ~10.0 (sigmoid ~0.9999), a clearly irrelevant pair scored logit ~-11.3
//   (sigmoid ~0.0000125). Sigmoid squashes to (0, 1) as instructed by the brief.
// - Explicit `dtype: "q8"` matters on every runtime, not just the browser: this package's
//   own `DEFAULT_DEVICE_DTYPE_MAPPING` (types/utils/dtypes.d.ts) only maps the "wasm"
//   device to "q8" — every other device (including Node's default execution provider)
//   falls back to `DEFAULT_DEVICE_DTYPE = "fp32"`, which downloads the full ~90 MB
//   onnx/model.onnx instead of the ~23 MB onnx/model_quantized.onnx the brief specifies.
//   Passing `dtype: "q8"` explicitly forces the quantized file everywhere, so the browser
//   and the Node eval mirror (scripts/lib/search-core.mjs) score with the identical model.

// Pure blend/normalize math lives in lib/rerank-core.ts so the Cloudflare search Worker can
// reuse it without dragging in the `@huggingface/transformers` dynamic import below (T2).
// Re-exported here so existing importers of lib/rerank keep working unchanged.
import { RERANK_WINDOW, RerankCandidate, blendRerankScores, minMaxNormalize } from "@/lib/rerank-core";
import { threadText } from "@/lib/thread-text";
export { RERANK_WINDOW, minMaxNormalize };
export type { RerankCandidate };

export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

const ARTICLE_EXCERPT_CHARS = 300;
const DOC_TEXT_CHAR_CAP = 1000;
const THREAD_EXCERPT_CHARS = 300;

// Minimal call-signature types for the two loaded objects, matching the existing codebase
// convention (see embedQueries's `extractor` cast in components/bookmarks-app.tsx) rather
// than fighting the library's dynamically-resolved (config-driven) TS return types.
type RerankTokenizer = (
  texts: string[],
  options: { text_pair: string[]; padding: boolean; truncation: boolean },
) => unknown;
type RerankModel = (inputs: unknown) => Promise<{ logits: { dims: number[]; data: Iterable<number> } }>;

let rerankerPromise: Promise<{ tokenizer: RerankTokenizer; model: RerankModel }> | null = null;

// Same retry-on-failure contract as `warmupEmbedder`/`embedQueries`'s `extractorPromise`
// in components/bookmarks-app.tsx: `??=` memoizes success, but a rejected promise must NOT
// stay memoized forever, or one transient failure (idle warmup racing a flaky network,
// say) would silently disable rerank for the rest of the session even after conditions
// recover. On failure, reset `rerankerPromise` to null so the NEXT call (another warmup
// attempt, or the next real `rerankResults`/`scoreWithCrossEncoder` call) gets a fresh
// `from_pretrained` attempt instead of re-awaiting the same dead promise.
async function loadReranker() {
  rerankerPromise ??= (async () => {
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@huggingface/transformers");
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(RERANK_MODEL),
      AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: "q8" }),
    ]);
    return {
      tokenizer: tokenizer as unknown as RerankTokenizer,
      model: model as unknown as RerankModel,
    };
  })();
  try {
    return await rerankerPromise;
  } catch (err) {
    rerankerPromise = null;
    throw err;
  }
}

/**
 * Idle-time warmup: loads (and memoizes) the cross-encoder without scoring anything. Never
 * throws — a failed warmup resets the memo (see `loadReranker` above) and the NEXT call
 * (a later rerank, since there's no repeat warmup within one page load) gets a fresh
 * attempt. `rerankResults`'s own try/catch is the real silent-skip gate for query-time
 * failures; this function's try/catch exists only so a failed warmup itself never throws
 * into the idle-callback chain.
 */
export async function warmupReranker(): Promise<void> {
  try {
    await loadReranker();
  } catch {
    // Silent — see the doc comment above.
  }
}

function sigmoid(logit: number): number {
  return 1 / (1 + Math.exp(-logit));
}

// Default scorer: the real cross-encoder. Exposed as a separate function (rather than
// inlined into rerankResults) so the Node mirror (scripts/lib/search-core.mjs) and this
// module share the same shape — an injectable `scoreFn` — for testability without loading
// the real model (see scripts/test-search-core.mjs, which stubs this).
export async function scoreWithCrossEncoder(query: string, docTexts: string[]): Promise<number[]> {
  const { tokenizer, model } = await loadReranker();
  const inputs = tokenizer(
    docTexts.map(() => query),
    { text_pair: docTexts, padding: true, truncation: true },
  );
  const output = await model(inputs);
  return Array.from(output.logits.data).map((logit) => sigmoid(logit as number));
}

/**
 * Doc text fed to the cross-encoder as the "passage" half of the (query, passage) pair:
 * an "@screenName (author name): " authorship prefix, then post text + articleTitle +
 * first ARTICLE_EXCERPT_CHARS chars of articleText + quoted tweet text + the first
 * THREAD_EXCERPT_CHARS of the author's thread, whitespace-collapsed
 * and capped at DOC_TEXT_CHAR_CAP chars. The cross-encoder truncates at 512 tokens anyway,
 * so this cap is a cheap pre-truncation for tokenizer throughput, not a correctness
 * requirement.
 *
 * The authorship prefix is a deliberate deviation from the original brief (which excluded
 * author fields entirely): without it, the cross-encoder only sees post text, so for
 * handle-class queries (e.g. "rauchg") it ranks tweets that *mention* "@rauchg" above tweets
 * *authored by* rauchg — the keyword index's boosted `author` field is the only thing
 * currently supplying that signal, and rerank was silently discarding it. See
 * .orchestrate/task-11-report.md's "Fix wave r1" section for the eval numbers that justified
 * this change.
 */
export function buildRerankDocText(post: {
  text?: string;
  articleTitle?: string;
  articleText?: string;
  author?: { name?: string; screenName?: string };
  quotedTweet?: { text?: string };
  thread?: Array<{ text?: string }>;
}): string {
  const screenName = post.author?.screenName;
  const authorName = post.author?.name;
  const authorPrefix = screenName ? `@${screenName}${authorName ? ` (${authorName})` : ""}: ` : undefined;
  const parts = [
    authorPrefix,
    post.text,
    post.articleTitle,
    post.articleText ? post.articleText.slice(0, ARTICLE_EXCERPT_CHARS) : undefined,
    post.quotedTweet?.text,
    post.thread?.length ? threadText(post).slice(0, THREAD_EXCERPT_CHARS) : undefined,
  ].filter((part): part is string => Boolean(part));
  const collapsed = parts.join(" ").replace(/\s+/g, " ").trim();
  return collapsed.slice(0, DOC_TEXT_CHAR_CAP);
}

type RerankScoreFn = (query: string, docTexts: string[]) => Promise<number[]>;

/**
 * Cross-encoder rerank of the top `limit` hybrid results. Min-max normalizes BOTH the
 * cross-encoder scores and the incoming hybrid scores over that window, blends
 * `CE_BLEND_WEIGHT * ce + HYBRID_BLEND_WEIGHT * hybrid`, re-sorts the window, and appends
 * the untouched tail (results beyond `limit`, in their original order and scores) after it.
 *
 * Silent-skip contract: on ANY failure (model load, tokenization, inference, or a
 * scorer returning the wrong number of scores) this returns `results` completely
 * unchanged — never throws, never surfaces an error to the caller/UI. A single
 * `console.debug` fires per failed call (dev-only signal; a no-op in most production
 * consoles unless verbose logging is explicitly enabled).
 *
 * This is the actual scoring work, always run through the `rerankResults` coalescing
 * scheduler below — never called directly by anything outside this module.
 */
async function performRerank(
  query: string,
  results: RerankCandidate[],
  getDocText: (id: string) => string,
  limit: number,
  scoreFn: RerankScoreFn,
): Promise<RerankCandidate[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery || results.length < 2) return results;

  const window = results.slice(0, limit);
  const tail = results.slice(limit);

  try {
    const docTexts = window.map((r) => getDocText(r.id));
    const ceScoresRaw = await scoreFn(trimmedQuery, docTexts);
    if (!Array.isArray(ceScoresRaw) || ceScoresRaw.length !== window.length) {
      throw new Error(
        `rerank: scoreFn returned ${Array.isArray(ceScoresRaw) ? ceScoresRaw.length : typeof ceScoresRaw} scores for a window of ${window.length}`,
      );
    }

    const blended = blendRerankScores(window, ceScoresRaw);

    return [...blended, ...tail];
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[rerank] skipped:", err);
    }
    return results;
  }
}

type PendingRerankTask = {
  query: string;
  results: RerankCandidate[];
  getDocText: (id: string) => string;
  limit: number;
  scoreFn: RerankScoreFn;
  resolve: (value: RerankCandidate[]) => void;
};

// F1 fix (see .orchestrate/review-task11-quality-r1.md): a cross-encoder forward pass runs
// single-threaded on the main JS thread (no COOP/COEP headers -> self.crossOriginIsolated is
// false -> transformers.js forces WASM numThreads = 1) and cannot be aborted mid-flight —
// the `cancelled` closure in components/bookmarks-app.tsx only gates the phase-2 setState,
// not the in-flight `await scoreFn(...)` itself. Left alone, a user pausing between two
// debounce windows can stack a second full tokenize+forward pass on top of a first one still
// running, extending main-thread-blocked time roughly additively.
//
// Fix: a module-level latest-wins coalescing scheduler. At most ONE scoring pass is ever in
// flight. A `rerankResults` call never starts inference itself — it always parks as "the
// pending task" first, replacing (and immediately resolving, silent-skip style, with ITS OWN
// input order) whatever was previously parked, then a deferred microtask promotes the sole
// remaining pending task to "in flight" if nothing is already running. Because the promotion
// is deferred by one microtask, two `rerankResults` calls issued synchronously back-to-back
// (no `await` between them) also coalesce onto only the later one — the earlier one is
// superseded before it ever starts scoring. When an in-flight pass finishes, it immediately
// tries to promote whatever is currently parked (if anything arrived meanwhile).
//
// Each caller still gets its own Promise resolving with its own result: a task that actually
// runs gets a real blended result; a superseded parked task resolves with its own `results`
// unchanged (the same silent-skip contract as any other rerank failure — cheap, since the
// caller's own `cancelled` flag already ignores a superseded result's phase-2 setState).
//
// Node mirror (scripts/lib/search-core.mjs) note: scripts/eval-search.mjs awaits each
// `rerankResults` call fully before issuing the next, so this scheduler is transparent for
// that serial usage — nothing is ever in flight when the next call parks, so every eval query
// still gets its own real scoring pass (see scripts/test-search-core.mjs's "serial awaited
// calls" assertion).
let rerankInFlight = false;
let pendingRerankTask: PendingRerankTask | null = null;

function scheduleNextRerankTask(): void {
  if (rerankInFlight || !pendingRerankTask) return;
  const task = pendingRerankTask;
  pendingRerankTask = null;
  rerankInFlight = true;
  performRerank(task.query, task.results, task.getDocText, task.limit, task.scoreFn)
    .then(task.resolve)
    .finally(() => {
      rerankInFlight = false;
      scheduleNextRerankTask();
    });
}

/**
 * `scoreFn` defaults to the real cross-encoder (`scoreWithCrossEncoder`) and is only ever
 * overridden by tests, which stub it to exercise the blend math (and the coalescing
 * scheduler above) without loading the real ~23 MB model.
 */
export function rerankResults(
  query: string,
  results: RerankCandidate[],
  getDocText: (id: string) => string,
  limit: number = RERANK_WINDOW,
  scoreFn: RerankScoreFn = scoreWithCrossEncoder,
): Promise<RerankCandidate[]> {
  return new Promise<RerankCandidate[]>((resolve) => {
    if (pendingRerankTask) {
      // Superseded before it ever started scoring — silent-skip contract: it resolves with
      // ITS OWN input order unchanged, never the new task's.
      pendingRerankTask.resolve(pendingRerankTask.results);
    }
    pendingRerankTask = { query, results, getDocText, limit, scoreFn, resolve };
    void Promise.resolve().then(scheduleNextRerankTask);
  });
}
