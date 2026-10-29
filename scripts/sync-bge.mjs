// Orchestrates the bge Worker-data refresh step of `npm run sync`: embed whatever is new/changed,
// then rebuild the Worker-served artifacts.
//
// Flow:
//   1. `node embed-bge.mjs --dry-run` (local only, no network) to see what's pending. Nothing
//      pending (the common case) → no embedding at all.
//   2. Pick the embed transport (scripts/lib/embed-transport.mjs):
//        rest  — Workers AI REST with CLOUDFLARE_API_TOKEN (default; probed with one tiny embed).
//                No local server, so nothing can collide with other apps' ports.
//        local — fallback when there's no token or it lacks the Workers AI permission (or
//                EMBED_TRANSPORT=local): a throwaway `wrangler dev` in worker/ on a FREE port
//                (OS-assigned, inspector too), probed for real before use, its whole process group
//                torn down on success, error, SIGINT/SIGTERM or exit.
//      EMBED_TRANSPORT=rest|local forces one.
//   3. Always: rebuild lunr-index.json + rerank-docs.json and repack search-index-bge.{bin,meta.json}
//      (all written atomically) so the Worker artifacts stay aligned with the corpus.
//
// Extra CLI args (e.g. `--full`) are forwarded to both embed-bge.mjs invocations.

import { spawn } from "node:child_process";
import { readFile, mkdir, appendFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localTransport, probeRest, resolveAccountId } from "./lib/embed-transport.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workerDir = join(root, "worker");
const rawLogDir = join(root, ".orchestrate/raw");
const wranglerLogPath = join(rawLogDir, "sync-bge-wrangler.log");

// The local fallback asks the OS for free ports (wrangler hard-fails "Address in use" and never picks
// another one — a fixed 8799 broke the 2026-10-29 sync when another app owned it).
const WRANGLER_READY_TIMEOUT_MS = 120_000;
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

/** An OS-assigned free TCP port on 127.0.0.1. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The repo-pinned wrangler (worker/package.json), not whatever `npx` would resolve today. */
function wranglerCommand() {
  const pinned = join(workerDir, "node_modules", ".bin", "wrangler");
  return existsSync(pinned) ? { cmd: pinned, args: [] } : { cmd: "npx", args: ["wrangler"] };
}

let wranglerProc = null;

async function startWranglerDev() {
  await mkdir(rawLogDir, { recursive: true });
  const port = await freePort();
  const inspectorPort = await freePort();
  await writeFile(wranglerLogPath, ""); // one run per log: it used to grow forever
  log(`starting wrangler dev on 127.0.0.1:${port} (inspector ${inspectorPort}) — log: ${wranglerLogPath}`);
  const { cmd, args } = wranglerCommand();

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args, "dev", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspectorPort)], {
      cwd: workerDir,
      env: process.env, // wrangler reads Cloudflare auth from `wrangler login`, CLOUDFLARE_API_TOKEN, or worker/.dev.vars itself
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
      // Fail fast with actionable guidance if wrangler can't authenticate, instead of hanging
      // until the ready-timeout. This project intentionally does NOT persist a token on disk, so
      // a fresh shell must provide Cloudflare auth per session (see docs/SYNC-AND-DEPLOY.md).
      if (!settled && /not logged in|CLOUDFLARE_API_TOKEN|not authenticated/i.test(buffer)) {
        settled = true;
        clearTimeout(timer);
        reject(
          new Error(
            "Cloudflare auth is required for the embed step but wrangler is not authenticated.\n" +
              "  Fix (pick one), then re-run `npm run sync`:\n" +
              "    • cd worker && npx wrangler login      (browser OAuth)\n" +
              "    • export CLOUDFLARE_API_TOKEN=<token>   (this shell only)\n" +
              `  (No token is stored on disk by design.) Full wrangler log: ${wranglerLogPath}`,
          ),
        );
        return;
      }
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

const hasExited = (proc) => proc.exitCode !== null || proc.signalCode !== null;

async function stopWranglerDev() {
  if (!wranglerProc || wranglerProc.killed) return;
  if (hasExited(wranglerProc)) {
    // Already gone (e.g. it exited early): its "exit" event fired long ago, so waiting for it again
    // would just burn the grace period and log a misleading SIGKILL.
    wranglerProc = null;
    return;
  }
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
  if (wranglerProc && !wranglerProc.killed && wranglerProc.pid && !hasExited(wranglerProc)) {
    try {
      process.kill(-wranglerProc.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

/** rest when the token can call Workers AI, else the local wrangler dev fallback. */
async function chooseTransport() {
  const forced = process.env.EMBED_TRANSPORT;
  if (forced === "local") return { kind: "local" };
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const fallback = (why) => {
    if (forced === "rest") throw new Error(`EMBED_TRANSPORT=rest but ${why}`);
    log(`⚠ ${why} — falling back to a local wrangler dev`);
    return { kind: "local" };
  };
  if (!token) return fallback("no CLOUDFLARE_API_TOKEN for the Workers AI REST API");
  const account = await resolveAccountId(token, process.env.CLOUDFLARE_ACCOUNT_ID);
  if (account.error) return fallback(account.error);
  const probe = await probeRest({ accountId: account.accountId, token });
  // A transient probe failure (429/5xx) still means REST is the right transport; embed-bge retries.
  if (probe.ok || !probe.fatal) return { kind: "rest", accountId: account.accountId };
  return fallback(`Workers AI REST unavailable (${probe.error})`);
}

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
    const choice = await chooseTransport();
    if (choice.kind === "rest") {
      log("embedding via Workers AI REST (no local server)");
      await runNode(embedScript, forwardedArgs, { EMBED_TRANSPORT: "rest", CLOUDFLARE_ACCOUNT_ID: choice.accountId });
    } else {
      const embedSecret = (await readDevVar("EMBED_SECRET")) ?? process.env.EMBED_SECRET;
      if (!embedSecret) {
        throw new Error(
          "EMBED_SECRET not found in worker/.dev.vars (or the EMBED_SECRET env var) — cannot call the gated /embed route",
        );
      }
      const readyUrl = await startWranglerDev();
      try {
        // "Ready on" only means the HTTP server is up: prove /embed actually answers before the run.
        await localTransport({ url: `${readyUrl}/embed`, secret: embedSecret })(["ping"]);
        log(`wrangler dev ready at ${readyUrl} (/embed answered)`);
        await runNode(embedScript, forwardedArgs, { EMBED_TRANSPORT: "local", EMBED_URL: `${readyUrl}/embed`, EMBED_SECRET: embedSecret });
      } finally {
        await stopWranglerDev();
      }
    }
  } else {
    log("nothing pending — no embedding needed.");
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
