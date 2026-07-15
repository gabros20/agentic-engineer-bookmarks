// T4.1: structured query operators — `from:`, `before:`, `after:` — parsed out of the
// free-text search box so they can be applied as hard filters on the candidate pool
// (components/bookmarks-app.tsx `visiblePosts`) instead of being sent to hybrid search.
// Pure module, no React — mirrored verbatim as scripts/lib/query-operators.mjs so
// scripts/test-query-operators.mjs can exercise the same logic in plain Node (same
// lib/*.ts <-> scripts/lib/*.mjs convention as lib/bookmark-search.ts / search-core.mjs).

export type OperatorInvalidReason = "bad-date" | "bad-handle" | "unknown";

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
//
// `from:` gets its own alternative with an optional leading "wrapper" capture group
// (`(`, `"`, `'`, `[`, `{`) so a mention typed as `(from:simonw)` or `"from:simonw"` can be
// fully consumed — wrapper char included — instead of leaving an orphaned opening
// paren/quote behind in the residual text once the matching closer gets stripped off the
// handle value (see the `from` branch below). `before`/`after` are intentionally left on
// the unchanged, unwrapped alternative — their invalid-date handling is untouched.
const OPERATOR_TOKEN_RE = /([("'[{])?\bfrom:(\S+)|\b(before|after):(\S+)/gi;

const YYYY_MM_DD_RE = /^\d{4}-\d{2}-\d{2}$/;
const YYYY_MM_RE = /^\d{4}-\d{2}$/;

// A valid X/Twitter handle shape once `@` and enclosing punctuation are stripped.
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// Wrapper opener -> its matching closer, used to decide whether a leading wrapper char
// captured by OPERATOR_TOKEN_RE should be dropped (it was genuinely wrapping just the
// handle) or kept in the residual text (it wraps something bigger than the handle alone).
const WRAPPER_CLOSERS: Record<string, string> = { "(": ")", '"': '"', "'": "'", "[": "]", "{": "}" };

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
 * `from:` strips a leading `@`, then trims any run of non-handle characters (anything
 * outside `[A-Za-z0-9_]`) off both ends of what's left — this is what protects against
 * trailing/enclosing punctuation a person types naturally (`from:simonw,`, `from:@simonw.`,
 * `(from:simonw)`, `"from:simonw"`) from becoming part of the stored handle. If the
 * trimmed remainder matches `/^[A-Za-z0-9_]{1,15}$/` (X/Twitter handle shape) it's a valid
 * handle, lowercased and matched against `post.author.screenName.toLowerCase()` (exact —
 * not substring). If nothing valid remains (empty, or still-invalid interior characters
 * like `from:si+mon`), the whole token is recorded in `operators.invalid` with reason
 * `"bad-handle"` instead — same invalid-chip path as a bad date, so a `from:` typo is never
 * silently treated as a working (but unmatchable) filter. Multiple `from:` tokens: LAST
 * valid-or-invalid one wins (matches the regex's left-to-right match order, so later
 * assignments naturally overwrite earlier ones).
 *
 * Either way, the whole matched token (including any wrapping punctuation captured by
 * OPERATOR_TOKEN_RE's leading-wrapper group) leaves the residual text — see the `from`
 * branch below for how a leading `(`/`"`/etc. is dropped only when it's paired with the
 * matching closer that got trimmed off the tail of the value, so it never leaks into the
 * text sent to hybrid search/embedding, but a wrapper around a *bigger* phrase than just
 * the handle is left alone.
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
    .replace(
      OPERATOR_TOKEN_RE,
      (match: string, wrapper: string | undefined, fromValue: string | undefined, dateKeyword: string | undefined, dateValue: string | undefined) => {
        if (fromValue !== undefined) {
          const stripped = fromValue.replace(/^@/, "");
          const core = stripped.replace(/^[^A-Za-z0-9_]+/, "").replace(/[^A-Za-z0-9_]+$/, "");

          if (HANDLE_RE.test(core)) {
            from = core.toLowerCase();
          } else {
            invalid.push({ token: match, reason: "bad-handle" });
          }

          // Drop the leading wrapper char too, but only when it pairs with a closer that
          // was trimmed off the tail of the value (e.g. "(" + "simonw)" -> both consumed).
          // Otherwise the wrapper is genuinely user text (wraps more than just the handle)
          // and must survive in the residual.
          const closer = wrapper ? WRAPPER_CLOSERS[wrapper] : undefined;
          const trailingJunk = stripped.match(/[^A-Za-z0-9_]+$/)?.[0] ?? "";
          const dropWrapper = !wrapper || (closer !== undefined && trailingJunk.includes(closer));
          return dropWrapper ? " " : `${wrapper} `;
        }

        const key = (dateKeyword ?? "").toLowerCase();
        const date = parseOperatorDate(dateValue ?? "");
        if (!date) {
          invalid.push({ token: match, reason: "bad-date" });
          return " ";
        }
        if (key === "before") before = date;
        else after = date;
        return " ";
      },
    )
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
