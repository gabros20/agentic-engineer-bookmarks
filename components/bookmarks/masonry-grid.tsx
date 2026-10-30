"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type MasonryEntry = {
  key: string;
  /** Estimated rendered height (px) at the given column width; drives column placement only. */
  estimate: (columnWidth: number) => number;
  render: () => ReactNode;
};

type MasonryGridProps = {
  entries: MasonryEntry[];
  className?: string;
  /** Minimum column width from the sm breakpoint up (phones always get 2 columns). */
  minColumnWidth?: number;
};

const PHONE = 640;

// JS masonry instead of CSS `columns`. Chrome mis-paints composited (animated/blurred) content
// inside multi-column layout: cards lost their poster or vanished while scrolling. CSS columns
// also re-flow EVERY card whenever infinite scroll appends, so cards jumped between columns.
// Here each card is placed into the currently shortest column by an estimated height. Placement
// is greedy in list order, so appending entries never moves the ones already placed.
export function MasonryGrid({ entries, className, minColumnWidth = 280 }: MasonryGridProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    setWidth(node.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const phone = width < PHONE;
  const gap = phone ? 10 : 16;
  const count = phone ? 2 : Math.max(2, Math.floor((width + gap) / (minColumnWidth + gap)));
  const columnWidth = width ? (width - gap * (count - 1)) / count : 0;

  const columns: MasonryEntry[][] = Array.from({ length: count }, () => []);
  const heights = new Array<number>(count).fill(0);
  if (columnWidth > 0) {
    for (const entry of entries) {
      let shortest = 0;
      for (let i = 1; i < count; i++) if (heights[i] < heights[shortest] - 1) shortest = i;
      columns[shortest].push(entry);
      heights[shortest] += entry.estimate(columnWidth) + gap;
    }
  }

  return (
    <div ref={ref} className={className}>
      <div className="flex items-start" style={{ gap }}>
        {columns.map((column, index) => (
          <div key={index} className="flex min-w-0 flex-1 flex-col" style={{ gap }}>
            {column.map((entry) => (
              <div key={entry.key} className="min-w-0">
                {entry.render()}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
