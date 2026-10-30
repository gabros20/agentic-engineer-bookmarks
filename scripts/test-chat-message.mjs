// Unit tests for lib/chat-message.ts (follow-up parsing, citations, agent trace). Node runs the
// TypeScript directly (type stripping); the module has only type imports besides its own code.
import assert from "node:assert/strict";
import { answerText, citedSources, sourcePool, splitFollowups, statusIdOf, traceSteps } from "../lib/chat-message.ts";

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL - ${name}\n${error.message}`);
  }
}

test("splitFollowups: strips a complete block and parses its lines", () => {
  const { body, followups } = splitFollowups("Answer.\n\n<followups>\n- First?\n2. Second?\nThird?\n</followups>");
  assert.equal(body, "Answer.");
  assert.deepEqual(followups, ["First?", "Second?", "Third?"]);
});

test("splitFollowups: hides an unterminated block while streaming", () => {
  const { body, followups } = splitFollowups("Answer.\n<followups>\nFirst?\nSec");
  assert.equal(body, "Answer.");
  assert.deepEqual(followups, ["First?", "Sec"]);
});

test("splitFollowups: hides a half-typed opening tag at the end", () => {
  assert.equal(splitFollowups("Answer.\n<follo").body, "Answer.");
  assert.equal(splitFollowups("a < b").body, "a < b");
});

test("statusIdOf: reads x.com / twitter.com status ids", () => {
  assert.equal(statusIdOf("https://x.com/someone/status/1890123456789012345"), "1890123456789012345");
  assert.equal(statusIdOf("https://twitter.com/a/statuses/123456789"), "123456789");
  assert.equal(statusIdOf("https://example.com/post/1"), null);
});

const message = {
  id: "m1",
  role: "assistant",
  parts: [
    { type: "reasoning", text: "Plan the searches.", state: "done" },
    {
      type: "tool-search_bookmarks",
      state: "output-available",
      input: { query: "agent memory" },
      output: {
        count: 2,
        results: [
          { id: "111111", author: "A", screenName: "a", text: "one", url: "https://x.com/a/status/111111" },
          { id: "222222", author: "B", screenName: "b", text: "two", url: "https://x.com/b/status/222222" },
        ],
      },
    },
    { type: "tool-search_bookmarks", state: "input-available", input: { query: "memory consolidation" } },
    { type: "text", text: "See [B](https://x.com/b/status/222222) and [A](https://x.com/a/status/111111), again [B](https://x.com/b/status/222222)." },
  ],
};

test("sourcePool + citedSources: numbered by first mention, deduplicated", () => {
  const cited = citedSources(answerText(message), sourcePool(message));
  assert.deepEqual(cited.map((s) => s.id), ["222222", "111111"]);
});

test("traceSteps: reasoning, finished search with count, running search", () => {
  const steps = traceSteps(message);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0], { kind: "reasoning", text: "Plan the searches.", active: false });
  assert.equal(steps[1].count, 2);
  assert.equal(steps[1].active, false);
  assert.equal(steps[2].active, true);
  assert.equal(steps[2].count, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
