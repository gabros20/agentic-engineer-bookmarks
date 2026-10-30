"use client";

import { CornerDownRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { enter, stagger } from "@/lib/motion";
import { cn } from "@/lib/utils";

// Tappable prompts: the starters in an empty chat and the follow-ups after an answer. A vertical
// list rather than chips, so a long (Hungarian) question wraps inside a full-width row instead of
// being squeezed into a pill — and every row is a 44px+ target.

export function Suggestions({ items, onPick, label, className }: { items: string[]; onPick: (text: string) => void; label?: string; className?: string }) {
  const reduce = useReducedMotion();
  if (!items.length) return null;
  return (
    <section aria-label={label} className={cn("min-w-0", className)}>
      {label ? <h3 className="font-body mb-1 text-[12px] font-medium text-[color:var(--color-muted)]">{label}</h3> : null}
      <ul className="divide-y divide-[color:var(--color-hairline)]">
        {items.map((item, i) => (
          <motion.li key={item} initial={{ opacity: 0, y: reduce ? 0 : 6 }} animate={{ opacity: 1, y: 0, transition: { ...enter, delay: stagger(i, 0.05) } }}>
            <button
              type="button"
              onClick={() => onPick(item)}
              className="group flex min-h-11 w-full items-start gap-2.5 py-2.5 text-left text-[15px] leading-[1.45] text-[color:var(--color-body-strong)] transition-colors hover:text-[color:var(--color-ink)]"
            >
              <CornerDownRight
                size={15}
                className="mt-[3px] shrink-0 text-[color:var(--color-muted-soft)] transition-[color,transform] duration-200 ease-out-strong group-hover:translate-x-0.5 group-hover:text-[color:var(--color-ink)]"
              />
              <span className="min-w-0">{item}</span>
            </button>
          </motion.li>
        ))}
      </ul>
    </section>
  );
}
