"use client";

import { motion, useReducedMotion } from "motion/react";
import type { ChatSource } from "@/lib/chat-message";
import { enter, stagger } from "@/lib/motion";

// The bookmarks an answer cites, as a swipeable row of cards (Perplexity's source strip). The
// number on each card matches the citation chip in the text. Cards bleed to the panel edge so
// the next one peeks in — the cue that the row scrolls.

export function SourceStrip({ sources, label, onOpen }: { sources: ChatSource[]; label: string; onOpen?: (source: ChatSource) => void }) {
  const reduce = useReducedMotion();
  if (!sources.length) return null;
  return (
    <section aria-label={label} className="min-w-0">
      <h3 className="font-body mb-2 text-[12px] font-medium text-[color:var(--color-muted)]">{label}</h3>
      <ol className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:scroll-px-6 sm:px-6">
        {sources.map((source, i) => (
          <motion.li
            key={source.id}
            initial={{ opacity: 0, x: reduce ? 0 : 12 }}
            animate={{ opacity: 1, x: 0, transition: { ...enter, delay: stagger(i, 0.04) } }}
            className="w-[min(15rem,72vw)] shrink-0 snap-start"
          >
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                if (!onOpen) return;
                event.preventDefault();
                onOpen(source);
              }}
              className="flex h-full flex-col gap-1.5 rounded-xl bg-[color:var(--color-surface-card)] p-3 transition-[background-color,transform] duration-150 hover:bg-[color:var(--color-surface-cream-strong)] active:scale-[0.98]"
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[12px]">
                <CitationNumber n={i + 1} />
                <span className="truncate font-medium text-[color:var(--color-ink)]">{source.author}</span>
                <span className="truncate text-[color:var(--color-muted)]">@{source.screenName}</span>
              </span>
              <span className="line-clamp-3 text-[13px] leading-[1.45] text-[color:var(--color-body)]">{source.articleTitle || source.text}</span>
            </a>
          </motion.li>
        ))}
      </ol>
    </section>
  );
}

export function CitationNumber({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={`inline-grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-[color:var(--color-canvas)] px-1 text-[10.5px] font-semibold tabular-nums text-[color:var(--color-body)] ring-1 ring-[color:var(--color-hairline)] ${className ?? ""}`}
    >
      {n}
    </span>
  );
}
