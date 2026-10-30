"use client";

import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

// The header every sheet/panel shares (chat, digest, saved lists): icon + title on one line, an
// optional subtitle under it (what the panel is about), icon actions and close on the right.
// Titles truncate instead of wrapping; actions never shrink.

export function PanelHeader({
  icon,
  title,
  badge,
  subtitle,
  actions,
  closeLabel,
  onClose,
}: {
  icon: ReactNode;
  title: string;
  badge?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <header className="flex shrink-0 items-start gap-2 border-b border-[color:var(--color-hairline)] py-2.5 pl-4 pr-2 sm:pl-6 sm:pr-3">
      <div className="min-w-0 flex-1 py-1">
        <div className="flex min-w-0 items-center gap-2 text-[color:var(--color-ink)]">
          <span className="shrink-0 text-[color:var(--color-ink)]">{icon}</span>
          <h2 className="truncate font-display text-[22px] leading-[1.15]">{title}</h2>
          {badge}
        </div>
        {subtitle ? <div className="mt-0.5 line-clamp-2 break-words text-[13px] leading-[1.4] text-[color:var(--color-muted)]">{subtitle}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {actions}
        <IconButton label={closeLabel} onClick={onClose}>
          <X size={19} />
        </IconButton>
      </div>
    </header>
  );
}

/** A 40px (44px hit area on touch) icon-only button. `label` is required: it is the name. */
export function IconButton({
  label,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof motion.button>, "aria-label" | "children"> & { label: string; children: ReactNode }) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      whileTap={{ scale: 0.92 }}
      className={cn(
        "relative grid size-10 shrink-0 place-items-center rounded-full text-[color:var(--color-muted)] transition-colors hover:bg-[color:var(--color-surface-card)] hover:text-[color:var(--color-ink)] disabled:pointer-events-none disabled:opacity-40 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-0.5",
        className,
      )}
      {...props}
    >
      {children}
    </motion.button>
  );
}

/** Small uppercase status pill next to a title ("Saved"). */
export function PanelBadge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-full bg-[color:var(--color-surface-card)] px-2 py-0.5 text-[11px] font-medium text-[color:var(--color-muted)]">
      {children}
    </span>
  );
}
