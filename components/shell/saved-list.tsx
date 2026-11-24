"use client";

import { Loader2, Trash2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { enter, exit, spring, stagger } from "@/lib/motion";

// The body of a "saved things" sheet (digests, chats): skeleton rows while loading, a clear
// error, a friendly empty state, then the rows. Rows are a divided list, not cards in a card;
// delete is always visible on touch and appears on hover with a mouse.

export type SavedListState = "loading" | "error" | "ready";

export function SavedList({
  state,
  empty,
  errorText,
  alert,
  icon,
  children,
  count,
}: {
  state: SavedListState;
  empty: string;
  errorText: string;
  /** A transient action failure shown above the list (a delete that didn't stick…). */
  alert?: string | null;
  icon: ReactNode;
  count: number;
  children: ReactNode;
}) {
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-2 sm:px-6"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
    >
      {alert ? (
        <p role="alert" className="mb-2 mt-2 rounded-xl bg-[color:var(--color-error)]/8 px-3 py-2.5 text-[13px] text-[color:var(--color-error)]">
          {alert}
        </p>
      ) : null}
      {state === "loading" ? (
        <ul aria-busy="true" className="divide-y divide-[color:var(--color-hairline)]">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="py-4">
              <div className="ai-skeleton h-5 w-3/5 rounded-md" />
              <div className="ai-skeleton mt-2 h-3.5 w-2/5 rounded-md" />
            </li>
          ))}
        </ul>
      ) : state === "error" ? (
        <p className="py-12 text-center text-[14px] text-[color:var(--color-error)]">{errorText}</p>
      ) : count === 0 ? (
        <div className="grid justify-items-center gap-3 px-4 py-14 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-[color:var(--color-surface-card)] text-[color:var(--color-muted)]">{icon}</span>
          <p className="max-w-xs text-[14px] leading-[1.55] text-[color:var(--color-muted)]">{empty}</p>
        </div>
      ) : (
        <ul className="divide-y divide-[color:var(--color-hairline)]">
          <AnimatePresence initial={true}>{children}</AnimatePresence>
        </ul>
      )}
    </div>
  );
}

export function SavedRow({
  index,
  title,
  meta,
  preview,
  busy,
  onOpen,
  onDelete,
  deleteLabel,
}: {
  index: number;
  title: string;
  meta: string;
  preview?: string | null;
  busy?: boolean;
  onOpen: () => void;
  onDelete?: () => void;
  deleteLabel: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.li
      layout={reduce ? false : "position"}
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0, transition: { ...enter, delay: stagger(index, 0.03, 0.18) } }}
      exit={{ opacity: 0, x: reduce ? 0 : 24, transition: exit }}
      transition={spring}
      className="group relative"
    >
      <button type="button" onClick={onOpen} aria-busy={busy} className="block w-full py-3.5 pr-12 text-left transition-opacity active:opacity-70">
        <span className="line-clamp-2 font-display text-[19px] leading-[1.25] text-[color:var(--color-ink)]">{title}</span>
        <span className="mt-1 block truncate text-[12.5px] text-[color:var(--color-muted)]">{meta}</span>
        {preview ? <span className="mt-1.5 line-clamp-2 block text-[13.5px] leading-[1.5] text-[color:var(--color-body)]">{preview}</span> : null}
      </button>
      {busy ? (
        <Loader2 size={16} className="absolute right-3 top-4 animate-spin text-[color:var(--color-muted)]" />
      ) : onDelete ? (
        <button
          type="button"
          aria-label={deleteLabel}
          title={deleteLabel}
          onClick={onDelete}
          className="touch-target absolute right-0 top-2.5 grid size-10 place-items-center rounded-full text-[color:var(--color-muted)] transition-[opacity,background-color,color] duration-150 hover:bg-[color:var(--color-error)]/10 hover:text-[color:var(--color-error)] [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:focus-visible:opacity-100"
        >
          <Trash2 size={15} />
        </button>
      ) : null}
    </motion.li>
  );
}
