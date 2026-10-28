"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ResponsiveDialog, ResponsiveDialogContent, ResponsiveDialogTitle } from "@/components/ui/revola";
import { cn } from "@/lib/utils";

// Our panels mount already open and disappear when the parent stops rendering them, while Revola
// is a controlled dialog. This bridges the two: open on mount, and on any dismissal (Esc, overlay
// click, drawer swipe, or the panel's own close button via the render prop) play the close
// animation (Radix fade/zoom on desktop, Vaul slide on mobile) BEFORE telling the parent to unmount.
const CLOSE_ANIMATION_MS = 280;

type ResponsivePanelProps = {
  /** Accessible dialog title (rendered visually hidden; panels draw their own header). */
  title: string;
  onClose: () => void;
  className?: string;
  children: (close: () => void) => ReactNode;
};

export function ResponsivePanel({ title, onClose, className, children }: ResponsivePanelProps) {
  const [open, setOpen] = useState(true);
  const closing = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setOpen(false);
    window.setTimeout(() => onCloseRef.current(), CLOSE_ANIMATION_MS);
  }, []);

  return (
    <ResponsiveDialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <ResponsiveDialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn("flex flex-col gap-0 overflow-hidden p-0", className)}
      >
        <ResponsiveDialogTitle className="sr-only">{title}</ResponsiveDialogTitle>
        {children(close)}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
