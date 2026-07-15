// Node port of lib/query-operators.ts — keep in sync (same lib/*.ts <-> scripts/lib/*.mjs
// convention as lib/bookmark-search.ts / scripts/lib/search-core.mjs). Faithful copy of
// parseQueryOperators + its date parser so scripts/test-query-operators.mjs can exercise
// the exact production parsing logic in plain Node, without a React/TS build step.
//
// LOCKSTEP NOTE: any change to lib/query-operators.ts's regex, date rules, or last-wins/
// invalid-token behavior must be mirrored here too. No test currently guards drift between
// the two automatically (same as the search-core.mjs / bookmark-search.ts pair) — a manual
// diff is the contract.

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
const WRAPPER_CLOSERS = { "(": ")", '"': '"', "'": "'", "[": "]", "{": "}" };

function parseOperatorDate(value) {
  let isoLike;
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

export function parseQueryOperators(raw) {
  const invalid = [];
  let from;
  let before;
  let after;

  const text = raw
    .replace(OPERATOR_TOKEN_RE, (match, wrapper, fromValue, dateKeyword, dateValue) => {
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
    })
    .replace(/\s+/g, " ")
    .trim();

  return { text, operators: { from, before, after, invalid } };
}

export function removeOperatorTokens(raw, kind) {
  const re = new RegExp(`\\b${kind}:\\S+`, "gi");
  return raw
    .replace(re, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function removeInvalidToken(raw, token) {
  const idx = raw.indexOf(token);
  if (idx === -1) return raw.replace(/\s+/g, " ").trim();
  return (raw.slice(0, idx) + raw.slice(idx + token.length)).replace(/\s+/g, " ").trim();
}
