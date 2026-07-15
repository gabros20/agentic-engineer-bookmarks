// Lightweight unit tests for T4.1 query operators (from:/before:/after:).
// Plain node:assert, no framework (matches scripts/test-search-core.mjs). Run via
// `npm run test:operators`.

import assert from "node:assert/strict";
import { parseQueryOperators, removeInvalidToken, removeOperatorTokens } from "./lib/query-operators.mjs";

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`ok   - ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL - ${name}`);
    console.log(`       ${err.message}`);
  }
}

test("from: strips a leading @ and lowercases, exact handle captured", () => {
  const { text, operators } = parseQueryOperators("agents from:@SimonW");
  assert.equal(operators.from, "simonw");
  assert.equal(text, "agents");
});

test("from: without a leading @ still lowercases", () => {
  const { operators } = parseQueryOperators("from:Rauchg");
  assert.equal(operators.from, "rauchg");
});

test("before: accepts YYYY-MM-DD", () => {
  const { operators } = parseQueryOperators("before:2026-04-15");
  assert.ok(operators.before instanceof Date);
  assert.equal(operators.before.toISOString(), "2026-04-15T00:00:00.000Z");
});

test("after: accepts YYYY-MM-DD", () => {
  const { operators } = parseQueryOperators("after:2026-04-15");
  assert.ok(operators.after instanceof Date);
  assert.equal(operators.after.toISOString(), "2026-04-15T00:00:00.000Z");
});

test("before:/after: accept YYYY-MM as the first day of that month", () => {
  const { operators } = parseQueryOperators("after:2026-04 before:2026-05");
  assert.equal(operators.after.toISOString(), "2026-04-01T00:00:00.000Z");
  assert.equal(operators.before.toISOString(), "2026-05-01T00:00:00.000Z");
});

test("before: exclusivity semantics: before:2026-04 == strictly before April 1 (excludes all of April)", () => {
  const { operators } = parseQueryOperators("before:2026-04");
  const marchThirtyFirst = new Date("2026-03-31T23:59:59.999Z").getTime();
  const aprilFirst = new Date("2026-04-01T00:00:00.000Z").getTime();
  const boundary = operators.before.getTime();
  assert.ok(marchThirtyFirst < boundary, "March 31 end-of-day must be before the boundary (kept by before:)");
  assert.ok(aprilFirst >= boundary, "April 1 00:00 must NOT be before the boundary (excluded by before:)");
});

test("multiple from: tokens — last one wins", () => {
  const { operators } = parseQueryOperators("from:alice from:bob from:carol");
  assert.equal(operators.from, "carol");
});

test("unparseable date is recorded in invalid with reason bad-date, and removed from text either way", () => {
  const { text, operators } = parseQueryOperators("agents before:not-a-date");
  assert.equal(operators.before, undefined);
  assert.equal(operators.invalid.length, 1);
  assert.equal(operators.invalid[0].reason, "bad-date");
  assert.equal(operators.invalid[0].token, "before:not-a-date");
  assert.equal(text, "agents");
});

test("calendar-invalid date (e.g. Feb 30) is rejected, not silently rolled over", () => {
  const { operators } = parseQueryOperators("before:2026-02-30");
  assert.equal(operators.before, undefined);
  assert.equal(operators.invalid[0].reason, "bad-date");
});

test("mixed text + operators: residual text preserves surrounding words, collapses whitespace", () => {
  const { text, operators } = parseQueryOperators("  agents  from:@simonw   coding   after:2026-01  ");
  assert.equal(text, "agents coding");
  assert.equal(operators.from, "simonw");
  assert.equal(operators.after.toISOString(), "2026-01-01T00:00:00.000Z");
});

test("empty residual: query that is operators-only leaves an empty text string", () => {
  const { text, operators } = parseQueryOperators("from:@simonw before:2026-04");
  assert.equal(text, "");
  assert.equal(operators.from, "simonw");
  assert.ok(operators.before instanceof Date);
});

test("no operators present: text passes through unchanged (trimmed), operators all undefined", () => {
  const { text, operators } = parseQueryOperators("just a plain query");
  assert.equal(text, "just a plain query");
  assert.equal(operators.from, undefined);
  assert.equal(operators.before, undefined);
  assert.equal(operators.after, undefined);
  assert.deepEqual(operators.invalid, []);
});

test("operator keywords are case-insensitive (FROM:/Before:/AFTER:)", () => {
  const { operators } = parseQueryOperators("FROM:@simonw Before:2026-04 AFTER:2026-01");
  assert.equal(operators.from, "simonw");
  assert.ok(operators.before instanceof Date);
  assert.ok(operators.after instanceof Date);
});

// ---- chip removal helpers ---------------------------------------------------

test("removeOperatorTokens: strips every occurrence of a kind, keeps other text and other operators", () => {
  const result = removeOperatorTokens("agents from:alice coding from:bob after:2026-01", "from");
  assert.equal(result, "agents coding after:2026-01");
});

test("removeOperatorTokens: no matching tokens is a no-op (aside from trim/collapse)", () => {
  assert.equal(removeOperatorTokens("agents coding", "before"), "agents coding");
});

test("removeInvalidToken: removes only the first occurrence of the exact literal token", () => {
  const result = removeInvalidToken("agents before:nonsense coding", "before:nonsense");
  assert.equal(result, "agents coding");
});

test("removeInvalidToken: token not present in the string is a no-op (aside from trim/collapse)", () => {
  assert.equal(removeInvalidToken("agents coding", "before:nonsense"), "agents coding");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
