// Backfill video/GIF posters (`thumbnail`) and video `durationMs` into the archive in place.
//
// Why: the ~2k bookmarks imported from the legacy twitter-cli archive never had posters, and
// `xrelay archive bookmarks` is incremental (it never revisits tweets already in the file), so
// they stay posterless while every new capture already carries one. The card renders the poster
// with an inline player (components/bookmark-card.tsx).
//
// Source: X's public syndication endpoint (what Vercel's react-tweet uses) — no cookies, so no
// account risk and no xrelay rate budget. Deleted/protected posts come back as a TweetTombstone
// or 404 and are left as-is (the card falls back to its placeholder).
//
// Idempotent: only media items missing a thumbnail (or a video missing durationMs) are touched,
// existing values are never overwritten. Holds the auto-sync lock so it can't race a sync that
// rewrites the same file. Writes atomically, checkpointing every SAVE_EVERY fills.
//
//   node scripts/backfill-posters.mjs [--dry-run] [--concurrency 4] [--limit N]
// then `npm run upload:r2` to publish the archive.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LOCK_PATH } from "./lib/autosync-config.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const archivePath = join(root, "public/data/all-bookmarks.json");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const flagValue = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const CONCURRENCY = flagValue("--concurrency", 4);
const LIMIT = flagValue("--limit", Infinity);
const SAVE_EVERY = 100;
const TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 4;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// react-tweet's token derivation; the endpoint rejects requests without it.
export function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

// The media key shared by a video/GIF url and its poster:
//   video.twimg.com/amplify_video/<id>/vid/…   ↔ pbs.twimg.com/amplify_video_thumb/<id>/img/…
//   video.twimg.com/ext_tw_video/<id>/pu/vid/… ↔ pbs.twimg.com/ext_tw_video_thumb/<id>/pu/img/…
//   video.twimg.com/tweet_video/<name>.mp4     ↔ pbs.twimg.com/tweet_video_thumb/<name>.jpg
export function mediaKey(url) {
  if (typeof url !== "string") return null;
  return url.match(/_video(?:_thumb)?\/(\d+)\//)?.[1] ?? url.match(/tweet_video(?:_thumb)?\/([^/.?]+)/)?.[1] ?? null;
}

const isMotion = (m) => m?.type === "video" || m?.type === "gif" || m?.type === "animated_gif";
const needsFill = (m) => isMotion(m) && (!m.thumbnail || (m.type === "video" && m.durationMs === undefined));

async function fetchSyndication(id) {
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}&lang=en`;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) return { status: "failed", reason: err?.message ?? String(err) };
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status === 404) return { status: "unresolved", reason: "404" };
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= MAX_ATTEMPTS) return { status: "failed", reason: `HTTP ${res.status}` };
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) return { status: "failed", reason: `HTTP ${res.status}` };
    const body = await res.json().catch(() => null);
    const details = Array.isArray(body?.mediaDetails) ? body.mediaDetails.filter(isMotion) : [];
    if (!details.length) return { status: "unresolved", reason: body?.__typename ?? "no media" };
    return { status: "ok", details };
  }
}

// Fill one tweet's media from the syndication mediaDetails. Match by media key; fall back to
// position only when both sides list the same number of videos/GIFs. Returns items filled.
function applyDetails(tweet, details) {
  const motion = tweet.media.filter(isMotion);
  let filled = 0;
  motion.forEach((item, index) => {
    if (!needsFill(item)) return;
    const key = mediaKey(item.url);
    const match =
      (key && details.find((d) => mediaKey(d.media_url_https) === key)) ||
      (motion.length === details.length ? details[index] : undefined);
    if (!match) return;
    let changed = false;
    if (!item.thumbnail && typeof match.media_url_https === "string") {
      item.thumbnail = match.media_url_https;
      changed = true;
    }
    const duration = match.video_info?.duration_millis;
    if (item.type === "video" && item.durationMs === undefined && Number.isFinite(duration)) {
      item.durationMs = duration;
      changed = true;
    }
    if (changed) filled++;
  });
  return filled;
}

function acquireLock() {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  if (existsSync(LOCK_PATH)) {
    const pid = Number(readFileSync(LOCK_PATH, "utf8").trim());
    try {
      process.kill(pid, 0);
      return false; // a sync is running
    } catch {
      // stale lock
    }
  }
  writeFileSync(LOCK_PATH, String(process.pid));
  return true;
}

function releaseLock() {
  try {
    if (readFileSync(LOCK_PATH, "utf8").trim() === String(process.pid)) unlinkSync(LOCK_PATH);
  } catch {
    // already gone
  }
}

async function saveArchive(archive) {
  const tmpPath = `${archivePath}.tmp.${process.pid}`;
  await writeFile(tmpPath, JSON.stringify(archive));
  await rename(tmpPath, archivePath);
}

async function main() {
  if (!DRY_RUN && !acquireLock()) {
    console.error(`a sync holds ${LOCK_PATH} — rerun when it finishes`);
    process.exit(1);
  }
  try {
    const archive = JSON.parse(await readFile(archivePath, "utf8"));
    if (!Array.isArray(archive.tweets)) throw new Error("expected an xrelay archive (`tweets` array)");
    const candidates = archive.tweets.filter((t) => Array.isArray(t.media) && t.media.some(needsFill)).slice(0, LIMIT);
    console.log(`${candidates.length} tweets with a video/GIF missing a poster or duration${DRY_RUN ? " (dry run)" : ""}`);

    const stats = { tweets: candidates.length, filledItems: 0, filledTweets: 0, unresolved: 0, failed: 0 };
    const unresolvedReasons = {};
    let sinceSave = 0;
    let next = 0;
    let done = 0;

    async function worker() {
      while (next < candidates.length) {
        const tweet = candidates[next++];
        const result = await fetchSyndication(tweet.id);
        if (result.status === "ok") {
          const filled = applyDetails(tweet, result.details);
          if (filled) {
            stats.filledItems += filled;
            stats.filledTweets++;
            sinceSave++;
          } else {
            stats.unresolved++;
            unresolvedReasons["no matching media"] = (unresolvedReasons["no matching media"] ?? 0) + 1;
          }
        } else {
          stats[result.status]++;
          unresolvedReasons[result.reason] = (unresolvedReasons[result.reason] ?? 0) + 1;
        }
        if (++done % 100 === 0) console.log(`  ${done}/${candidates.length} · filled ${stats.filledTweets}`);
        if (!DRY_RUN && sinceSave >= SAVE_EVERY) {
          sinceSave = 0;
          await saveArchive(archive);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, worker));
    if (!DRY_RUN && stats.filledTweets) await saveArchive(archive);
    console.log(JSON.stringify({ ...stats, unresolvedReasons }, null, 2));
    if (!DRY_RUN && stats.filledTweets) console.log("archive updated — run `npm run upload:r2` to publish it");
    // Everything failing (vs. tombstones) means the endpoint or network is broken, not the data.
    if (stats.tweets > 0 && stats.filledTweets === 0 && stats.failed >= 3) process.exit(1);
  } finally {
    if (!DRY_RUN) releaseLock();
  }
}

await main();
