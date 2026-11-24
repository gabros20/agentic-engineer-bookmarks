"use client";

import { ArrowDown } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ComponentProps } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { enter, exit } from "@/lib/motion";
import { cn } from "@/lib/utils";

// The scrolling message log. Sticks to the bottom while an answer streams, lets go as soon as the
// reader scrolls up, and offers a way back down. `role="log"` makes screen readers announce new
// messages politely.

export function Conversation({ className, ...props }: ComponentProps<typeof StickToBottom>) {
  return <StickToBottom className={cn("relative min-h-0 flex-1 overflow-y-hidden", className)} initial="instant" resize="smooth" role="log" {...props} />;
}

export function ConversationContent({ className, ...props }: ComponentProps<typeof StickToBottom.Content>) {
  return <StickToBottom.Content className={cn("flex flex-col gap-7 px-4 py-5 sm:px-6", className)} {...props} />;
}

export function ScrollToBottom({ label }: { label: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {!isAtBottom ? (
        <motion.button
          type="button"
          aria-label={label}
          onClick={() => scrollToBottom()}
          initial={{ opacity: 0, scale: reduce ? 1 : 0.9, y: reduce ? 0 : 6 }}
          animate={{ opacity: 1, scale: 1, y: 0, transition: enter }}
          exit={{ opacity: 0, scale: reduce ? 1 : 0.9, transition: exit }}
          whileTap={{ scale: 0.94 }}
          className="touch-target absolute bottom-3 left-1/2 z-10 -ml-5 grid size-10 place-items-center rounded-full bg-[color:var(--color-canvas)] text-[color:var(--color-ink)] shadow-[var(--shadow-float)] ring-1 ring-[color:var(--color-hairline)]"
        >
          <ArrowDown size={16} />
        </motion.button>
      ) : null}
    </AnimatePresence>
  );
}
