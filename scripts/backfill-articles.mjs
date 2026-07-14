// Backfill X Article bodies: fetch markdown for bookmarks whose `article.markdown`
// is empty via the global `xrelay` CLI, and write it into the archive file in place.
//
// Idempotent: re-running only touches tweets with empty article.markdown, so an
// already-filled archive is a no-op, and a crash mid-run resumes for free (the
// archive is saved to disk every 10 successes).
//
// ID resolution (confirmed by manual probing, see .orchestrate/raw/task2-probe.json
// and .orchestrate/task-2-report.md): `xrelay article <id>` wants the ARCHIVE TWEET's
// own id — the tweet that *displays* the article card, whether it authored the
// article directly or is quote-tweeting the tweet that did. The numeric id embedded
// in the `x.com/i/article/<id>` URL (when present in `urls`) is a distinct internal
// Article object id and reliably returns NOT_FOUND when passed to this command — it
// is NOT used here despite being present in the data.

import { execFile } from "node:child_process";
import { readFile, writeFile, appendFile } from "node:fs/promises";
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

async function saveArchive(archive) {
  await writeFile(archivePath, JSON.stringify(archive));
}

async function logFailure(entry) {
  await appendFile(failuresLogPath, `${JSON.stringify(entry)}\n`);
}

const archive = JSON.parse(await readFile(archivePath, "utf8"));
const targets = archive.tweets.filter((t) => t.article && !t.article.markdown);

if (targets.length === 0) {
  console.log("No empty article bodies to backfill — nothing to do.");
  process.exit(0);
}

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

if (aborted || filledRatio < 0.9) {
  console.error(`Below the 90% fill threshold (or aborted early) — exiting 1.`);
  process.exit(1);
}

process.exit(0);
