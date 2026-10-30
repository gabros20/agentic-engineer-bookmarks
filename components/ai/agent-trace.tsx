"use client";

import { Brain, ChevronDown, FileText, Search } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { TraceStep } from "@/lib/chat-message";
import { cn } from "@/lib/utils";

// One compact row for everything the agent did before answering — reasoning and tool calls —
// instead of a card per call. While it works, the row is a live, shimmering status ("Searching
// “agent memory” · 4s"); when the answer starts it settles into a summary ("Searched 4× ·
// 63 bookmarks · 6s") that expands into the step list. Patterned on ChatGPT's "Thought for…"
// sheet and Perplexity's "N steps completed" (Mobbin, Oct 2026).

export type TraceLabels = {
  thinking: string;
  searching: (query: string) => string;
  reading: string;
  thought: (seconds: number | null) => string;
  searched: (searches: number, results: number) => string;
  read: (n: number) => string;
  seconds: (n: number) => string;
  failed: string;
  results: (n: number) => string;
  readStep: (author: string | null) => string;
};

type AgentTraceProps = {
  steps: TraceStep[];
  /** The agent is still working (no answer text yet, or a tool call in flight). */
  running: boolean;
  /** A live message (timed). Reopened saved chats have no timing. */
  live: boolean;
  labels: TraceLabels;
};

export function AgentTrace({ steps, running, live, labels }: AgentTraceProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const seconds = useElapsed(running, live);

  if (!running && steps.length === 0) return null;

  const searches = steps.filter((s) => s.kind === "search");
  const reads = steps.filter((s) => s.kind === "read");
  const resultCount = searches.reduce((sum, s) => sum + (s.count ?? 0), 0);
  const current = [...steps].reverse().find((s) => s.active);

  let label: string;
  if (running) {
    label = current?.kind === "search" && current.query ? labels.searching(current.query) : current?.kind === "read" ? labels.reading : labels.thinking;
  } else {
    const parts: string[] = [];
    if (searches.length) parts.push(labels.searched(searches.length, resultCount));
    if (reads.length) parts.push(labels.read(reads.length));
    if (!parts.length) parts.push(labels.thought(seconds));
    else if (seconds) parts.push(labels.seconds(seconds));
    label = parts.join(" · ");
  }

  const Icon = running
    ? current?.kind === "search"
      ? Search
      : current?.kind === "read"
        ? FileText
        : Brain
    : searches.length
      ? Search
      : Brain;
  const expandable = steps.length > 0;

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? panelId : undefined}
        disabled={!expandable}
        className="-ml-1.5 flex min-h-8 max-w-full items-center gap-2 rounded-lg px-1.5 text-left text-[13px] text-[color:var(--color-muted)] transition-colors enabled:hover:text-[color:var(--color-ink)] disabled:cursor-default"
      >
        <Icon size={14} className="shrink-0" />
        <span aria-live="polite" className={cn("min-w-0 truncate", running && "ai-shimmer")}>
          {label}
          {running && seconds ? ` · ${labels.seconds(seconds)}` : ""}
        </span>
        {expandable ? <ChevronDown size={14} className={cn("shrink-0 transition-transform duration-200 ease-out-strong", open && "rotate-180")} /> : null}
      </button>

      <div id={panelId} className="disclosure" data-open={open} inert={!open}>
        <div>
          <ol className="relative ml-[6px] mt-1.5 space-y-2.5 border-l border-[color:var(--color-hairline)] pb-1 pl-4">
            {steps.map((step, i) => (
              <li key={i} className="text-[13px] leading-[1.5]">
                {step.kind === "reasoning" ? (
                  <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[color:var(--color-muted)]">{step.text}</p>
                ) : step.kind === "search" ? (
                  <div className="flex min-w-0 items-center gap-2 text-[color:var(--color-body)]">
                    <Search size={13} className="shrink-0 text-[color:var(--color-muted)]" />
                    <span className="min-w-0 flex-1 truncate">{step.query ? `“${step.query}”` : "…"}</span>
                    <span className="shrink-0 tabular-nums text-[color:var(--color-muted)]">
                      {step.failed ? labels.failed : step.count === null ? "…" : labels.results(step.count)}
                    </span>
                  </div>
                ) : (
                  <div className="flex min-w-0 items-center gap-2 text-[color:var(--color-body)]">
                    <FileText size={13} className="shrink-0 text-[color:var(--color-muted)]" />
                    <span className="min-w-0 flex-1 truncate">{step.failed ? labels.failed : labels.readStep(step.author)}</span>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

/** Whole seconds since `running` first became true; frozen once it stops. */
function useElapsed(running: boolean, live: boolean) {
  const startedAt = useRef<number | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!live || !running) return;
    startedAt.current ??= Date.now();
    const tick = () => setSeconds(Math.max(1, Math.round((Date.now() - (startedAt.current ?? Date.now())) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearInterval(timer);
      tick();
    };
  }, [running, live]);
  return seconds;
}
