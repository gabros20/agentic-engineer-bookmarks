"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { VideoMedia, isMotionMedia, pbsSrcSet, pbsVariant, type MediaEntry } from "@/components/bookmark-card";
import { useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Media in the detail view, laid out the way x.com does it (measured on x.com, Oct 2026), so every
// item fits on screen without scrolling past it:
//
//   1 item    its own aspect at full width; a tall one is height-capped and gets narrower
//             (left-aligned) instead of cropped
//   2 items   side by side at their own aspects, one shared height that exactly fills the width
//   3+ items  a scroll-snap carousel with one row height; an item is at most 80% of the width
//             (wider ones lose their sides, never top/bottom) so the next one always peeks in
//
// The height cap is the visible part of the detail panel, so a phone screenshot never runs off
// screen. Anything cropped here is shown whole in the full-screen viewer (media-lightbox.tsx).
// Each item carries data-media-index: the viewer zooms from / back to it.

const GAP = 4; // px, x.com's gap
const MIN_ASPECT = 0.5; // taller than 1:2 crops top/bottom (rare; the viewer shows it whole)
const MAX_ASPECT = 3;
const PEEK = 0.8; // carousel items take at most this share of the width

export type DetailMediaLayout = {
  mode: "single" | "pair" | "carousel";
  height: number;
  widths: number[];
};

/** Pure layout math (exported for tests): item widths + shared height for a content width. */
export function detailMediaLayout(aspects: number[], width: number, maxHeight: number): DetailMediaLayout {
  const a = aspects.map((x) => Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, x || 16 / 9)));
  if (a.length === 1) {
    const height = Math.min(width / a[0], maxHeight);
    return { mode: "single", height, widths: [Math.min(width, height * a[0])] };
  }
  if (a.length === 2) {
    const pair = a.map((x) => Math.min(x, 2));
    const height = Math.min((width - GAP) / (pair[0] + pair[1]), maxHeight);
    return { mode: "pair", height, widths: pair.map((x) => height * x) };
  }
  // Tall enough that the widest item reaches the peek width, at least x.com's 0.68 × width.
  const height = Math.min(maxHeight, Math.max(width * 0.68, (width * PEEK) / Math.max(...a)));
  return {
    mode: "carousel",
    height,
    widths: a.map((x) => Math.min(height * x, width * PEEK)),
  };
}

function aspectOf(item: MediaEntry) {
  return item.width && item.height ? item.width / item.height : 16 / 9;
}

export function DetailMedia({ media, onOpenMedia }: { media: MediaEntry[]; onOpenMedia: (index: number) => void }) {
  const { t } = useLanguage();
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; maxHeight: number } | null>(null);
  const [edges, setEdges] = useState({ start: true, end: true });

  // Content width, and the visible height of the scrolling panel this sits in.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const panel = root.closest<HTMLElement>("[data-detail-scroll]");
      const visible = panel?.clientHeight || window.innerHeight * 0.7;
      const next = {
        width: root.clientWidth,
        maxHeight: Math.max(220, Math.round(visible * 0.82)),
      };
      setBox((prev) => (prev && Math.abs(prev.width - next.width) < 1 && prev.maxHeight === next.maxHeight ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    const panel = root.closest<HTMLElement>("[data-detail-scroll]");
    if (panel) observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const layout = box ? detailMediaLayout(media.map(aspectOf), box.width, box.maxHeight) : null;
  const carousel = layout?.mode === "carousel";

  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const start = el.scrollLeft <= 2;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useLayoutEffect(() => {
    if (carousel) updateEdges();
  }, [carousel, layout?.height, box?.width, updateEdges]);

  function step(direction: 1 | -1) {
    const el = scrollerRef.current;
    if (!el || !layout) return;
    el.scrollBy({
      left: direction * (layout.widths[0] + GAP),
      behavior: "smooth",
    });
  }

  return (
    // The root measures the content width; the carousel inside bleeds into the panel padding so
    // items scroll edge to edge (the peeking item reaches the panel edge, like x.com).
    <div ref={rootRef} style={layout ? undefined : { minHeight: 220 }}>
      <div className={cn("group/media relative", carousel && "-mx-5 sm:-mx-8")}>
        {layout ? (
          <div
            ref={scrollerRef}
            onScroll={carousel ? updateEdges : undefined}
            className={cn(
              "flex",
              carousel &&
                "snap-x snap-mandatory scroll-px-5 overflow-x-auto overscroll-x-contain px-5 [scrollbar-width:none] sm:scroll-px-8 sm:px-8 [&::-webkit-scrollbar]:hidden",
            )}
            style={{ gap: GAP }}
          >
            {media.map((item, index) => (
              <div
                key={`${item.url}-${index}`}
                data-media-index={index}
                className="shrink-0 snap-start overflow-hidden rounded-xl bg-[color:var(--color-surface-card)]"
                style={{ width: layout.widths[index], height: layout.height }}
              >
                {isMotionMedia(item) ? (
                  <VideoMedia item={item} className="h-full w-full" sizes={`${Math.round(layout.widths[index])}px`} onOpen={() => onOpenMedia(index)} />
                ) : (
                  <button type="button" onClick={() => onOpenMedia(index)} aria-label={t("media.view")} className="block h-full w-full cursor-zoom-in">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      className="h-full w-full object-cover"
                      src={pbsVariant(item.url ?? "", "medium")}
                      srcSet={item.url ? pbsSrcSet(item.url, true) : undefined}
                      sizes={`${Math.round(layout.widths[index])}px`}
                      alt=""
                      decoding="async"
                    />
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : null}

        {/* Mouse users can't swipe: step buttons on hover (touch screens scroll natively). */}
        {carousel ? (
          <>
            <CarouselButton side="left" label={t("detail.prev")} hidden={edges.start} onClick={() => step(-1)}>
              <ChevronLeft size={18} />
            </CarouselButton>
            <CarouselButton side="right" label={t("detail.next")} hidden={edges.end} onClick={() => step(1)}>
              <ChevronRight size={18} />
            </CarouselButton>
          </>
        ) : null}
      </div>
    </div>
  );
}

function CarouselButton({
  side,
  label,
  hidden,
  onClick,
  children,
}: {
  side: "left" | "right";
  label: string;
  hidden: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      tabIndex={hidden ? -1 : 0}
      className={cn(
        "absolute top-1/2 grid size-9 -translate-y-1/2 cursor-pointer place-items-center rounded-full bg-[color:var(--color-canvas)]/90 text-[color:var(--color-ink)] shadow-[var(--shadow-float)] ring-1 ring-[color:var(--color-hairline)] backdrop-blur transition duration-200 hover:scale-105 [@media(hover:none)]:hidden",
        side === "left" ? "left-3 sm:left-5" : "right-3 sm:right-5",
        hidden ? "pointer-events-none opacity-0" : "opacity-0 group-hover/media:opacity-100 focus-visible:opacity-100",
      )}
    >
      {children}
    </button>
  );
}
