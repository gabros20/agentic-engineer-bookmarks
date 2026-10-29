// Turn a failed sync into something actionable: a stable code, whether retrying later can help,
// whether to tell the user right away, and a one-line fix. Patterns come from real failures in
// ~/Library/Logs/xbookmarks-sync (Sep–Oct 2026). First match wins, so order matters.

const RULES = [
  {
    code: "OFFLINE",
    test: /ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNRESET|getaddrinfo|network is (down|unreachable)|offline|fetch failed/i,
    retryable: true,
    title: "No internet connection",
    hint: "It retries automatically when you're back online.",
  },
  {
    code: "X_AUTH",
    test: /xrelay whoami|not logged in to x|auth_token|ct0|x\.com.*(login|session)|preflight: X auth/i,
    retryable: false,
    title: "X login expired",
    hint: "Open x.com in your browser and log in (or run: npm run autosync -- set-cookies). It retries automatically.",
  },
  {
    code: "CF_AUTH",
    test: /rejected the token|Invalid API Token|Authentication error|code: 10000|9109|not (logged in|authenticated)|could not be refreshed|Cloudflare auth|CLOUDFLARE_API_TOKEN/i,
    retryable: false,
    title: "Cloudflare token problem",
    hint: "Renew it: npm run autosync -- set-token  (needs Workers R2 Storage: Edit + Workers AI: Read).",
  },
  {
    code: "TRUNCATED",
    test: /archive shrank/i,
    retryable: false,
    title: "Bookmark pull looked truncated",
    hint: "Nothing was published; the previous archive was restored. Check X/xrelay, then run: npm run autosync -- run",
  },
  {
    code: "DISK",
    test: /ENOSPC|no space left|low disk/i,
    retryable: false,
    title: "Disk is full",
    hint: "Free at least 1 GB, then run: npm run autosync -- run",
  },
  {
    code: "AI_RATE_LIMIT",
    test: /\b429\b|rate.?limit|too many requests|\b3040\b/i,
    retryable: true,
    title: "Cloudflare rate limit",
    hint: "Temporary — it retries automatically in a couple of hours.",
  },
  {
    code: "UPLOAD",
    test: /upload-r2|manifest switch|upload of /i,
    retryable: true,
    title: "Publishing to Cloudflare failed",
    hint: "Usually a transient Cloudflare error — it retries automatically; the live site keeps the previous data.",
  },
  {
    code: "EMBED",
    test: /sync-bge|embed|Workers AI|wrangler dev/i,
    retryable: true,
    title: "Embedding new bookmarks failed",
    hint: "Progress is saved and it retries automatically. Persisting? npm run autosync -- doctor",
  },
];

const UNKNOWN = {
  code: "UNKNOWN",
  retryable: true,
  title: "Sync failed",
  hint: "It retries automatically. Details: npm run autosync -- open",
};

/** Classify an error message (plus optional captured output). */
export function classifyError(message, output = "") {
  const haystack = `${message}\n${output}`;
  const rule = RULES.find((r) => r.test.test(haystack)) ?? UNKNOWN;
  const { test: _test, ...info } = rule;
  return info;
}

export const ERROR_CODES = [...RULES.map((r) => r.code), UNKNOWN.code];
