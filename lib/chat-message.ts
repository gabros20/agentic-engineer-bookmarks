import type { UIMessage } from "ai";
import type { GetBookmarkResult, SearchBookmarksResult } from "@/lib/chat-tools";

// Pure helpers that turn an assistant UIMessage (text + reasoning + tool parts) into what the chat
// renders: the visible answer, its follow-up suggestions, the bookmarks it cites, and a compact
// trace of what the agent did. No React here, so it can be unit-tested and reused for saved chats.

/** The system prompt asks the model to end with `<followups>q1\nq2\nq3</followups>`. */
const FOLLOWUPS_RE = /<followups>([\s\S]*?)(?:<\/followups>|$)/i;
const OPEN_TAG = "<followups>";

export function splitFollowups(text: string): { body: string; followups: string[] } {
  const match = FOLLOWUPS_RE.exec(text);
  if (!match) {
    // A tag still being typed at the very end of a stream (`<fol`, `<followups`) is hidden too.
    const lt = text.lastIndexOf("<");
    const partial = lt >= 0 && text.length - lt < OPEN_TAG.length && OPEN_TAG.startsWith(text.slice(lt).toLowerCase());
    return { body: (partial ? text.slice(0, lt) : text).trimEnd(), followups: [] };
  }
  const followups = match[1]
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length > 2 && line.length < 200)
    .slice(0, 4);
  return { body: text.slice(0, match.index).trimEnd(), followups };
}

export type ChatSource = {
  id: string;
  author: string;
  screenName: string;
  text: string;
  articleTitle?: string;
  url: string;
};

type ToolLikePart = {
  type: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

function toolParts(message: UIMessage): ToolLikePart[] {
  return (message.parts as ToolLikePart[]).filter((p) => p.type === "tool-search_bookmarks" || p.type === "tool-get_bookmark");
}

/** Every bookmark the agent saw in this message's tool results, keyed by id. */
export function sourcePool(message: UIMessage): Map<string, ChatSource> {
  const pool = new Map<string, ChatSource>();
  for (const part of toolParts(message)) {
    if (part.state !== "output-available" || !part.output) continue;
    if (part.type === "tool-search_bookmarks") {
      for (const r of (part.output as SearchBookmarksResult).results ?? []) {
        if (!pool.has(r.id)) pool.set(r.id, r);
      }
    } else {
      const b = (part.output as GetBookmarkResult).bookmark;
      if (b && !pool.has(b.id)) pool.set(b.id, b);
    }
  }
  return pool;
}

const STATUS_ID_RE = /\/status(?:es)?\/(\d{5,25})/g;

export function statusIdOf(url: string): string | null {
  STATUS_ID_RE.lastIndex = 0;
  return STATUS_ID_RE.exec(url)?.[1] ?? null;
}

/** The pool entries the answer links to, in order of first mention (that order numbers them). */
export function citedSources(answer: string, pool: Map<string, ChatSource>): ChatSource[] {
  const cited: ChatSource[] = [];
  const seen = new Set<string>();
  // The same post saved twice (a repost, a quote) has two ids but is one source.
  const seenText = new Set<string>();
  for (const match of answer.matchAll(STATUS_ID_RE)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const source = pool.get(id);
    if (!source) continue;
    const key = `${source.screenName}:${source.text.slice(0, 120)}`;
    if (seenText.has(key)) continue;
    seenText.add(key);
    cited.push(source);
  }
  return cited;
}

export type TraceStep =
  | { kind: "reasoning"; text: string; active: boolean }
  | { kind: "search"; query: string; count: number | null; active: boolean; failed: boolean }
  | { kind: "read"; author: string | null; active: boolean; failed: boolean };

/** What the agent did before (and between) writing: reasoning and tool calls, in order. */
export function traceSteps(message: UIMessage): TraceStep[] {
  const steps: TraceStep[] = [];
  for (const raw of message.parts as Array<ToolLikePart & { text?: string }>) {
    if (raw.type === "reasoning") {
      const text = (raw.text ?? "").trim();
      if (text) steps.push({ kind: "reasoning", text, active: raw.state === "streaming" });
      continue;
    }
    if (raw.type !== "tool-search_bookmarks" && raw.type !== "tool-get_bookmark") continue;
    const active = raw.state === "input-streaming" || raw.state === "input-available";
    const failed = raw.state === "output-error" || Boolean((raw.output as { error?: string } | undefined)?.error);
    if (raw.type === "tool-search_bookmarks") {
      const query = String((raw.input as { query?: string } | undefined)?.query ?? "").trim();
      const count = raw.state === "output-available" ? ((raw.output as SearchBookmarksResult)?.results?.length ?? 0) : null;
      steps.push({ kind: "search", query, count, active, failed });
    } else {
      const author = raw.state === "output-available" ? ((raw.output as GetBookmarkResult)?.bookmark?.author ?? null) : null;
      steps.push({ kind: "read", author, active, failed });
    }
  }
  return steps;
}

/** The answer text of a message (all text parts, joined). */
export function answerText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
}
