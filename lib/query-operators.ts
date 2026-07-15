// T4.1: structured query operators — `from:`, `before:`, `after:` — parsed out of the
// free-text search box so they can be applied as hard filters on the candidate pool
// (components/bookmarks-app.tsx `visiblePosts`) instead of being sent to hybrid search.
// Pure module, no React — mirrored verbatim as scripts/lib/query-operators.mjs so
// scripts/test-query-operators.mjs can exercise the same logic in plain Node (same
// lib/*.ts <-> scripts/lib/*.mjs convention as lib/bookmark-search.ts / search-core.mjs).

export type OperatorInvalidReason = "bad-date" | "unknown";

export type QueryOperators = {
  from?: string;
  before?: Date;
  after?: Date;
  invalid: Array<{ token: string; reason: OperatorInvalidReason }>;
};

export type ParsedQuery = {
  text: string;
  operators: QueryOperators;
};

// Matches `keyword:value` where value is any run of non-whitespace (so `from:@simonw`,
// `before:2026-04-15`, `after:2026-04` all match; a bare `before:` with nothing after it
// does NOT match — \S+ requires at least one char — and is left as plain residual text).
const OPERATOR_TOKEN_RE = /\b(from|before|after):(\S+)/gi;

const YYYY_MM_DD_RE = /^\d{4}-\d{2}-\d{2}$/;
const YYYY_MM_RE = /^\d{4}-\d{2}$/;

/**
 * Parse `YYYY-MM-DD` or `YYYY-MM` into a UTC midnight Date. `YYYY-MM` is treated as the
 * first day of that month (the exclusive/inclusive distinction between `before:`/`after:`
 * is applied by the CALLER — see parseQueryOperators below — this function always returns
 * "the calendar date the token names", nothing more).
 *
 * Rejects both malformed strings AND calendar-invalid ones (e.g. `2026-02-30`, which
 * `new Date(...)` would otherwise silently roll over to March 2) by round-tripping the
 * parsed Date's UTC y/m/d back against the input and requiring an exact match.
 */
function parseOperatorDate(value: string): Date | null {
  let isoLike: string;
  if (YYYY_MM_DD_RE.test(value)) {
    isoLike = value;
  } else if (YYYY_MM_RE.test(value)) {
    isoLike = `${value}-01`;
  } else {
    return null;
  }

  const date = new Date(`${isoLike}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;

  const [y, m, d] = isoLike.split("-").map(Number);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() + 1 !== m || date.getUTCDate() !== d) return null;

  return date;
}

/**
 * Split a raw search-box query into residual free text plus structured operators.
 *
 * Date semantics: `after:X` keeps posts with date >= X at 00:00 UTC (inclusive lower
 * bound); `before:X` keeps posts with date < X at 00:00 UTC (EXCLUSIVE upper bound) — so
 * `before:2026-04` (== `before:2026-04-01`) means "strictly before April 1", i.e. it
 * excludes all of April itself, not just the given day. Post date source is
 * `createdAtISO ?? createdAt` (applied by the caller, see components/bookmarks-app.tsx).
 *
 * `from:` strips a leading `@` and lowercases (matched against
 * `post.author.screenName.toLowerCase()`, exact — not substring). Multiple `from:` tokens:
 * LAST one wins (matches the regex's left-to-right match order, so later assignments
 * naturally overwrite earlier ones).
 *
 * An unparseable `before:`/`after:` date is recorded in `operators.invalid` (reason
 * `"bad-date"`) and still removed from the residual text either way — an invalid operator
 * should never leak into the text that gets sent to hybrid search. `"unknown"` is reserved
 * for future operator kinds this parser doesn't recognize yet; this parser's regex only
 * ever matches `from|before|after`, so it never emits `"unknown"` itself today.
 */
export function parseQueryOperators(raw: string): ParsedQuery {
  const invalid: Array<{ token: string; reason: OperatorInvalidReason }> = [];
  let from: string | undefined;
  let before: Date | undefined;
  let after: Date | undefined;

  const text = raw
    .replace(OPERATOR_TOKEN_RE, (match, keyword: string, value: string) => {
      const key = keyword.toLowerCase();
      if (key === "from") {
        from = value.replace(/^@/, "").toLowerCase();
        return " ";
      }

      const date = parseOperatorDate(value);
      if (!date) {
        invalid.push({ token: match, reason: "bad-date" });
        return " ";
      }
      if (key === "before") before = date;
      else after = date;
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();

  return { text, operators: { from, before, after, invalid } };
}

export type OperatorKind = "from" | "before" | "after";

/**
 * Remove every occurrence of a given operator kind's token(s) from the raw query string,
 * collapsing whitespace left behind. Used by the removable operator chips in
 * components/bookmarks-app.tsx: removing e.g. the `from:` chip strips ALL `from:\S+`
 * tokens, not just the last one that "won" under parseQueryOperators' last-wins rule,
 * since a user could have typed more than one.
 */
export function removeOperatorTokens(raw: string, kind: OperatorKind): string {
  const re = new RegExp(`\\b${kind}:\\S+`, "gi");
  return raw
    .replace(re, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Remove one specific invalid token's exact literal text (as recorded in
 * `operators.invalid[i].token`) from the raw query string — used by the invalid-token
 * warning chips. Removes only the FIRST occurrence: invalid tokens are an edge case, and
 * exact-substring removal keeps the "surgical string removal" contract simple.
 */
export function removeInvalidToken(raw: string, token: string): string {
  const idx = raw.indexOf(token);
  if (idx === -1) return raw.replace(/\s+/g, " ").trim();
  return (raw.slice(0, idx) + raw.slice(idx + token.length)).replace(/\s+/g, " ").trim();
}
