// Node port of lib/query-operators.ts — keep in sync (same lib/*.ts <-> scripts/lib/*.mjs
// convention as lib/bookmark-search.ts / scripts/lib/search-core.mjs). Faithful copy of
// parseQueryOperators + its date parser so scripts/test-query-operators.mjs can exercise
// the exact production parsing logic in plain Node, without a React/TS build step.
//
// LOCKSTEP NOTE: any change to lib/query-operators.ts's regex, date rules, or last-wins/
// invalid-token behavior must be mirrored here too. No test currently guards drift between
// the two automatically (same as the search-core.mjs / bookmark-search.ts pair) — a manual
// diff is the contract.

const OPERATOR_TOKEN_RE = /\b(from|before|after):(\S+)/gi;

const YYYY_MM_DD_RE = /^\d{4}-\d{2}-\d{2}$/;
const YYYY_MM_RE = /^\d{4}-\d{2}$/;

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
    .replace(OPERATOR_TOKEN_RE, (match, keyword, value) => {
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
