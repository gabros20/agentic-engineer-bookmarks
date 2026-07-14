// Backfill X Article bodies: fetch markdown for bookmarks whose `article.markdown`
// is empty via the global `xrelay` CLI, and write it into the archive file in place.
//
// Idempotent: re-running only touches tweets with empty article.markdown, so an
// already-filled archive is a no-op, and a crash mid-run resumes for free (the
// archive is saved to disk every 10 successes, atomically — see saveArchive).
//
// Exit contract (this script sits at the tail of every `npm run sync`, not just
// the one-shot backfill, so it must not fail a routine sync over one flaky
// article):
//   - exit 0 — nothing to do (no empty article bodies found).
//   - exit 0 — at least one article was filled this run, regardless of how many
//     others failed (partial progress is still progress).
//   - exit 0 — zero filled but failures are small-scale (<3): treated as
//     ordinary single-item flakiness, not evidence the environment is broken.
//   - exit 1 — zero filled AND failures are large-scale (>=3): every attempt
//     failed at meaningful volume, which reads as systemic breakage (auth
//     dead, network down) rather than a bad article.
//   - exit 1 — aborted early via CONSECUTIVE_FAILURE_ABORT (5 consecutive
//     failures mid-run): the same systemic signal, checked independently of
//     the totals above because it can fire even after some earlier fills.
//   - exit 1 — the `xrelay` binary itself is missing from PATH: detected by a
//     cheap preflight check before touching any article, so this fails loud
//     with ONE clear message instead of grinding through N identical
//     per-article failures.
//
// ID resolution (confirmed by manual probing, see .orchestrate/raw/task2-probe.json
// and .orchestrate/task-2-report.md): `xrelay article <id>` wants the ARCHIVE TWEET's
// own id — the tweet that *displays* the article card, whether it authored the
// article directly or is quote-tweeting the tweet that did. The numeric id embedded
// in the `x.com/i/article/<id>` URL (when present in `urls`) is a distinct internal
// Article object id and reliably returns NOT_FOUND when passed to this command — it
// is NOT used here despite being present in the data.

import { execFile } from "node:child_process";
import { readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const archivePath = join(root, "public/data/all-bookmarks.json");
const failuresLogPath = join(root, ".orchestrate/raw/task2-failures.log");

const SAVE_EVERY = 10;
const MIN_GAP_MS = 2000;
const MAX_GAP_MS = 5000;
const CONSECUTIVE_FAILURE_ABORT = 5; // signals a broken environment, not a bad article

function jitterMs(min, max) {
  return min + Math.random() * (max - min);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `xrelay article <id>`, returning the parsed envelope whether ok or not. */
async function fetchArticle(id) {
  try {
    const { stdout } = await execFileAsync("xrelay", ["article", id], {
      maxBuffer: 20 * 1024 * 1024,
      timeout: 30_000,
    });
    return JSON.parse(stdout);
  } catch (err) {
    // xrelay exits 1 on a command-level error but still prints the `{ok:false,...}`
    // envelope to stdout — recover it from the rejected exec error when present.
    if (err?.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        // fall through to synthetic envelope below
      }
    }
    return { ok: false, error: { code: "EXEC_ERROR", message: err?.message ?? String(err) } };
  }
}

async function fetchArticleWithRetry(id) {
  let envelope = await fetchArticle(id);
  if (envelope.ok) return envelope;

  const err = envelope.error ?? {};
  const backoff =
    err.code === "RATE_LIMITED" && Number.isFinite(err.retryAfterMs)
      ? Math.min(err.retryAfterMs, 60_000)
      : jitterMs(3000, 6000);
  await sleep(backoff);

  envelope = await fetchArticle(id);
  return envelope;
}

// Atomic save: write to a temp file in the same directory (same filesystem,
// so the rename below is atomic), then rename over the real path. A kill
// mid-write leaves only the .tmp file touched — archivePath itself is never
// observed in a partial state, so a crash can never hand the next run (or the
// app) a torn all-bookmarks.json.
async function saveArchive(archive) {
  const tmpPath = `${archivePath}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(archive));
  await rename(tmpPath, archivePath);
}

async function logFailure(entry) {
  await appendFile(failuresLogPath, `${JSON.stringify(entry)}\n`);
}

// Cheap, network-free preflight: `xrelay --help` just prints usage, so this
// only tells us whether the binary exists and is invocable on PATH — it does
// not touch auth/network. If the binary is simply missing (ENOENT), fail loud
// with one line instead of letting every target below fail identically.
async function checkXrelayAvailable() {
  try {
    await execFileAsync("xrelay", ["--help"], { timeout: 10_000 });
  } catch (err) {
    if (err?.code === "ENOENT") {
      console.error(
        "xrelay binary not found on PATH — install/configure xrelay, then re-run `npm run sync`.",
      );
      process.exit(1);
    }
    // Any other failure just means --help itself misbehaved (unlikely); the
    // binary is present, so let the per-article fetches surface the real
    // problem (auth, network, ...) through the normal retry/abort path.
  }
}

const archive = JSON.parse(await readFile(archivePath, "utf8"));
const targets = archive.tweets.filter((t) => t.article && !t.article.markdown);

if (targets.length === 0) {
  console.log("No empty article bodies to backfill — nothing to do.");
  process.exit(0);
}

await checkXrelayAvailable();

console.log(`Backfilling ${targets.length} article bod${targets.length === 1 ? "y" : "ies"}...`);

let filled = 0;
let failed = 0;
let consecutiveFailures = 0;
let sinceSave = 0;
let aborted = false;

for (const [i, tweet] of targets.entries()) {
  const id = tweet.id;
  const envelope = await fetchArticleWithRetry(id);

  if (envelope.ok && envelope.data?.markdown) {
    tweet.article.markdown = envelope.data.markdown;
    if (!tweet.article.title && envelope.data.title) {
      tweet.article.title = envelope.data.title;
    }
    filled++;
    consecutiveFailures = 0;
    sinceSave++;
    if (sinceSave >= SAVE_EVERY) {
      await saveArchive(archive);
      sinceSave = 0;
    }
  } else {
    const reason = envelope.ok
      ? { code: "EMPTY_MARKDOWN", message: "xrelay returned ok but no markdown field" }
      : (envelope.error ?? { code: "UNKNOWN", message: "no error detail" });
    await logFailure({ id, error: reason });
    failed++;
    consecutiveFailures++;
  }

  console.log(`[${i + 1}/${targets.length}] ${id} ${envelope.ok && envelope.data?.markdown ? "OK" : "FAILED"}`);

  if (consecutiveFailures >= CONSECUTIVE_FAILURE_ABORT) {
    console.error(
      `Aborting: ${consecutiveFailures} consecutive failures — this looks like an environment problem ` +
        `(auth/network), not isolated bad articles. Not grinding through the remaining ${targets.length - i - 1}.`,
    );
    aborted = true;
    break;
  }

  if (i < targets.length - 1) {
    await sleep(jitterMs(MIN_GAP_MS, MAX_GAP_MS));
  }
}

await saveArchive(archive);

const total = targets.length;
const filledRatio = filled / total;
console.log(`Done. Filled ${filled}/${total} (${(filledRatio * 100).toFixed(1)}%), failed ${failed}.`);
if (failed > 0) console.log(`Failure details: ${failuresLogPath}`);

// Recalibrated exit gate — see the header comment's "Exit contract" for the
// full rationale. Systemic breakage (auth dead, network down) exits 1 and
// makes `npm run sync` fail loud; isolated flaky articles in an otherwise-
// healthy sync never do.
const FAILURE_SCALE_THRESHOLD = 3;

if (aborted) {
  console.error(
    `Aborted after ${CONSECUTIVE_FAILURE_ABORT} consecutive failures — treating as systemic (auth/network), exiting 1.`,
  );
  process.exit(1);
}

if (filled === 0 && failed >= FAILURE_SCALE_THRESHOLD) {
  console.error(
    `Zero articles filled with ${failed} failures — looks systemic (auth/network/xrelay), not isolated flakiness. Exiting 1.`,
  );
  process.exit(1);
}

process.exit(0);
