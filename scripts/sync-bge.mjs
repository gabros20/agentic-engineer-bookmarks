// Orchestrates the bge Worker-data refresh step of `npm run sync` (Task 3). embed-bge.mjs
// needs the local `wrangler dev` (worker/) POST /embed route for Workers AI inference — this
// script brings that up just long enough to run the incremental embed, then tears it down,
// so `npm run sync` itself stays a single command with no manual wrangler-dev babysitting.
//
// Flow:
//   1. `node embed-bge.mjs --dry-run` (local only, no network) to see what's actually
//      pending. On the common case — nothing new/changed since the last sync — wrangler dev
//      is never started at all: a no-op sync stays genuinely zero-network-traffic.
//   2. If something IS pending: spawn `wrangler dev` in worker/ (its own process group),
//      wait for its "Ready on http://..." line, run embed-bge.mjs against that URL with
//      EMBED_SECRET read from worker/.dev.vars, then kill the whole wrangler process group
//      (SIGTERM, SIGKILL after a grace period) — also on error, and on this script's own
//      SIGINT/SIGTERM/uncaught exit, so a crash never leaves an orphaned wrangler dev.
//   3. Always (whether or not anything was embedded): rebuild lunr-index.json and
//      rerank-docs.json and repack search-index-bge.{bin,meta.json} from the current source,
//      so the three Worker-served artifacts stay aligned with search-index-bge.json/the
//      corpus even when this run's embed step touched nothing.
//
// Fallback: if wrangler-dev automation ever proves too brittle in some environment, the
// two-command manual path still works (see README "Syncing Fresh Bookmarks"):
//   1) cd worker && npx wrangler dev --port 8787        # leave running in one terminal
//   2) node scripts/embed-bge.mjs                       # in another terminal
//   3) node scripts/build-lunr-index.mjs && node scripts/build-rerank-docs.mjs \
//        && node scripts/pack-bge-index.mjs
//
// Any extra CLI args (e.g. `--full` for a from-scratch re-embed) are forwarded to both the
// dry-run and real embed-bge.mjs invocations.

import { spawn } from "node:child_process";
import { readFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerDir = join(root, "worker");
const rawLogDir = join(root, ".orchestrate/raw");
const wranglerLogPath = join(rawLogDir, "sync-bge-wrangler.log");

// Default to 8799 (not 8787) so this script's own throwaway `wrangler dev` never collides with
// a worker you're running manually on the conventional 8787 (wrangler hard-fails "Address in
// use" on collision — it does not auto-pick another port). Override with SYNC_BGE_WRANGLER_PORT.
const WRANGLER_PORT = Number(process.env.SYNC_BGE_WRANGLER_PORT ?? 8799);
const WRANGLER_READY_TIMEOUT_MS = 60_000;
const WRANGLER_SHUTDOWN_GRACE_MS = 5_000;

const forwardedArgs = process.argv.slice(2);

function log(msg) {
  console.log(`[sync-bge] ${msg}`);
}

async function readDevVar(name) {
  const path = join(workerDir, ".dev.vars");
  if (!existsSync(path)) return undefined;
  const text = await readFile(path, "utf8");
  const line = text.split("\n").find((l) => l.trim().startsWith(`${name}=`));
  if (!line) return undefined;
  return line
    .slice(line.indexOf("=") + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

/** Run a node script to completion, streaming its stdout/stderr through; rejects on non-zero exit. */
function runNode(scriptPath, args = [], extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${scriptPath} ${args.join(" ")} exited ${code}`));
    });
  });
}

/** Parse embed-bge.mjs --dry-run's final JSON summary line (last valid-JSON line of stdout). */
function parseDryRunSummary(stdout) {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      continue;
    }
  }
  throw new Error("embed-bge.mjs --dry-run produced no parseable JSON summary line");
}

let wranglerProc = null;

async function startWranglerDev() {
  await mkdir(rawLogDir, { recursive: true });
  log(`starting wrangler dev on :${WRANGLER_PORT} (worker/) — log: ${wranglerLogPath}`);

  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", "dev", "--port", String(WRANGLER_PORT)], {
      cwd: workerDir,
      env: process.env, // wrangler reads worker/.env (CLOUDFLARE_API_TOKEN) + worker/.dev.vars itself
      detached: true, // own process group, so teardown can signal wrangler's own child processes too
      stdio: ["ignore", "pipe", "pipe"],
    });
    wranglerProc = child;

    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `wrangler dev did not report "Ready on" within ${WRANGLER_READY_TIMEOUT_MS}ms — see ${wranglerLogPath}`,
        ),
      );
    }, WRANGLER_READY_TIMEOUT_MS);

    const onData = (chunk) => {
      const text = chunk.toString();
      buffer += text;
      appendFile(wranglerLogPath, text).catch(() => {});
      const match = buffer.match(/Ready on (http:\/\/\S+)/);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`wrangler dev exited early (code ${code}, signal ${signal}) before reporting ready — see ${wranglerLogPath}`));
    });
  });
}

async function stopWranglerDev() {
  if (!wranglerProc || wranglerProc.killed) return;
  const pid = wranglerProc.pid;
  log(`stopping wrangler dev (pid ${pid})`);
  try {
    process.kill(-pid, "SIGTERM"); // whole process group — wrangler spawns esbuild/workerd children
  } catch {
    try {
      wranglerProc.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  const exited = await Promise.race([
    new Promise((resolve) => wranglerProc.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), WRANGLER_SHUTDOWN_GRACE_MS)),
  ]);
  if (!exited) {
    log("wrangler dev did not exit gracefully within the grace period — SIGKILL");
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        wranglerProc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  wranglerProc = null;
}

// Guarantee teardown even on Ctrl-C or an unexpected crash, so a failed/interrupted sync
// never leaves an orphaned wrangler dev running.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await stopWranglerDev();
    process.exit(1);
  });
}
process.on("exit", () => {
  if (wranglerProc && !wranglerProc.killed && wranglerProc.pid) {
    try {
      process.kill(-wranglerProc.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

async function main() {
  const embedScript = join(root, "scripts/embed-bge.mjs");

  log("checking for pending bge vectors (dry run — local only, no network)...");
  const dryStdout = await runNode(embedScript, ["--dry-run", ...forwardedArgs]);
  const summary = parseDryRunSummary(dryStdout);
  log(
    `dry run: ${summary.pending} pending vector(s) — ${summary.new} new, ${summary.stale} changed content, ` +
      `${summary.migrated} migrated, ${summary.total} total.`,
  );

  if (summary.pending > 0) {
    const embedSecret = (await readDevVar("EMBED_SECRET")) ?? process.env.EMBED_SECRET;
    if (!embedSecret) {
      throw new Error(
        "EMBED_SECRET not found in worker/.dev.vars (or the EMBED_SECRET env var) — cannot call the gated /embed route",
      );
    }

    const readyUrl = await startWranglerDev();
    log(`wrangler dev ready at ${readyUrl}`);
    try {
      await runNode(embedScript, forwardedArgs, { EMBED_URL: `${readyUrl}/embed`, EMBED_SECRET: embedSecret });
    } finally {
      await stopWranglerDev();
    }
  } else {
    log("nothing pending — skipping wrangler dev entirely (true no-op sync, zero network traffic).");
  }

  log("building lunr index...");
  await runNode(join(root, "scripts/build-lunr-index.mjs"));
  log("building rerank docs...");
  await runNode(join(root, "scripts/build-rerank-docs.mjs"));
  log("packing bge index...");
  await runNode(join(root, "scripts/pack-bge-index.mjs"));
  log("done.");
}

main().catch(async (err) => {
  console.error(`[sync-bge] FAILED: ${err.message}`);
  await stopWranglerDev();
  process.exit(1);
});
