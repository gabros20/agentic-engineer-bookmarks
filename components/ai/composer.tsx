"use client";

import { ArrowUp, Search, Square, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { DURATION, EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

// The message composer: a rounded card with an auto-growing textarea (1 → 6 lines, then it
// scrolls) and a toolbar row under it — the search the AI is grounded in on the left, send/stop on
// the right. Patterned on ChatGPT / Copilot / DeepSeek's mobile composers (Mobbin, Oct 2026).
//
// iOS: the textarea is 16px so focusing it never zooms the page. On touch screens Return inserts a
// newline (there is a send button under the thumb); with a keyboard Enter sends, Shift+Enter breaks.

const MAX_HEIGHT = 168; // ≈ 6 lines at 16px / 1.5

export type ComposerStatus = "ready" | "submitted" | "streaming" | "error";

type ComposerProps = {
  onSubmit: (text: string) => void;
  onStop?: () => void;
  status: ComposerStatus;
  placeholder: string;
  sendLabel: string;
  stopLabel: string;
  /** The search this conversation is grounded in, shown as a chip in the toolbar. */
  context?: { label: string; clearLabel: string; onClear?: () => void } | null;
  autoFocus?: boolean;
  className?: string;
};

export function Composer({ onSubmit, onStop, status, placeholder, sendLabel, stopLabel, context, autoFocus, className }: ComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const busy = status === "submitted" || status === "streaming";
  const canSend = value.trim().length > 0 && !busy;

  // Grow with the text. Reset to auto first so it can also shrink after a send.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [value]);

  // Focus after the panel's enter animation has started, so iOS doesn't scroll mid-transition.
  useEffect(() => {
    if (!autoFocus) return;
    const timer = window.setTimeout(() => textareaRef.current?.focus({ preventScroll: true }), 120);
    return () => window.clearTimeout(timer);
  }, [autoFocus]);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text || busy) return;
    onSubmit(text);
    setValue("");
  }, [value, busy, onSubmit]);

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    if (window.matchMedia("(pointer: coarse)").matches) return;
    event.preventDefault();
    submit();
  }

  return (
    <form
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
      className={cn(
        "rounded-[22px] bg-[color:var(--color-canvas)] p-1.5 shadow-[0_1px_2px_rgb(9_9_11/0.04),0_8px_24px_-12px_rgb(9_9_11/0.14)] ring-1 ring-[color:var(--color-hairline)] transition-[box-shadow] duration-200 focus-within:ring-[color:var(--color-muted-soft)]",
        className,
      )}
    >
      <textarea
        ref={textareaRef}
        rows={1}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        enterKeyHint="send"
        aria-label={placeholder}
        className="block max-h-[168px] w-full resize-none bg-transparent px-3 pb-1 pt-2 text-[16px] leading-6 text-[color:var(--color-ink)] outline-none placeholder:text-[color:var(--color-muted-soft)]"
      />
      <div className="flex min-h-10 items-center gap-2 pl-1.5">
        {context ? <ContextChip {...context} /> : null}
        <SendButton busy={busy} canSend={canSend} onStop={onStop} sendLabel={sendLabel} stopLabel={stopLabel} />
      </div>
    </form>
  );
}

function ContextChip({ label, clearLabel, onClear }: { label: string; clearLabel: string; onClear?: () => void }) {
  return (
    <span className="flex h-8 min-w-0 items-center gap-1.5 rounded-full bg-[color:var(--color-surface-card)] pl-2.5 pr-1 text-[13px] text-[color:var(--color-body)]">
      <Search size={13} className="shrink-0 text-[color:var(--color-muted)]" />
      <span className="truncate">{label}</span>
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          aria-label={clearLabel}
          title={clearLabel}
          className="grid size-6 shrink-0 place-items-center rounded-full text-[color:var(--color-muted)] transition-colors hover:bg-[color:var(--color-surface-cream-strong)] hover:text-[color:var(--color-ink)]"
        >
          <X size={12} />
        </button>
      ) : (
        <span className="w-1.5 shrink-0" />
      )}
    </span>
  );
}

function SendButton({
  busy,
  canSend,
  onStop,
  sendLabel,
  stopLabel,
}: {
  busy: boolean;
  canSend: boolean;
  onStop?: () => void;
  sendLabel: string;
  stopLabel: string;
}) {
  const reduce = useReducedMotion();
  const label = busy ? stopLabel : sendLabel;
  // Send ↔ stop swap their glyphs with a short blur crossfade, so it reads as one control
  // changing state rather than two buttons trading places.
  const swap = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, scale: 0.6, filter: "blur(2px)" },
        animate: { opacity: 1, scale: 1, filter: "blur(0px)" },
        exit: { opacity: 0, scale: 0.6, filter: "blur(2px)" },
      };
  return (
    <motion.button
      type={busy ? "button" : "submit"}
      onClick={busy ? onStop : undefined}
      disabled={!busy && !canSend}
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.92 }}
      className="relative ml-auto grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-[color:var(--color-primary)] text-[color:var(--color-on-primary)] transition-[background-color,opacity] duration-200 hover:bg-[color:var(--color-primary-active)] disabled:cursor-default disabled:bg-[color:var(--color-surface-cream-strong)] disabled:text-[color:var(--color-muted)]"
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={busy ? "stop" : "send"} {...swap} transition={{ duration: DURATION.fast, ease: EASE_OUT }} className="grid place-items-center">
          {busy ? <Square size={12} fill="currentColor" /> : <ArrowUp size={17} strokeWidth={2.25} />}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
