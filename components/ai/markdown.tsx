"use client";

import { code } from "@streamdown/code";
import { createContext, memo, useContext, type ComponentProps, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { statusIdOf } from "@/lib/chat-message";
import { cn } from "@/lib/utils";

// Streamed markdown for AI answers. Only the code plugin is loaded (no math/mermaid/CJK — an
// answer about bookmarks never needs them, and they are the heaviest chunks). New words fade in
// as they stream, which hides the token-by-token jitter. Links to a cited bookmark get a numbered
// chip that matches the source strip.

/** id → citation number, provided by the message that renders the markdown. */
const CitationContext = createContext<Map<string, number>>(new Map());

export function CitationProvider({ value, children }: { value: Map<string, number>; children: ReactNode }) {
  return <CitationContext.Provider value={value}>{children}</CitationContext.Provider>;
}

const plugins = { code };
const animation = { animation: "fadeIn", duration: 220, easing: "ease-out", sep: "word" } as const;

function CitedLink({ href, children, ...props }: ComponentProps<"a">) {
  const citations = useContext(CitationContext);
  const id = href ? statusIdOf(href) : null;
  const n = id ? citations.get(id) : undefined;
  const text = typeof children === "string" ? children : null;
  // A bare autolinked URL reads badly; the chip alone stands in for it.
  const bare = text !== null && /^https?:\/\//.test(text);
  return (
    <a
      {...props}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-[color:var(--color-ink)] underline decoration-[color:var(--color-muted-soft)] decoration-1 underline-offset-[3px] transition-colors hover:decoration-[color:var(--color-ink)]"
    >
      {bare && n ? null : children}
      {n ? (
        <span className="ml-1 inline-grid h-[17px] min-w-[17px] translate-y-[-1px] place-items-center rounded-full bg-[color:var(--color-surface-card)] px-1 align-middle text-[10.5px] font-semibold tabular-nums text-[color:var(--color-body)] no-underline">
          {n}
        </span>
      ) : null}
    </a>
  );
}

const components = { a: CitedLink };

export const Markdown = memo(function Markdown({ children, streaming, className }: { children: string; streaming: boolean; className?: string }) {
  return (
    <Streamdown
      className={cn(
        "min-w-0 text-[15px] leading-[1.65] text-[color:var(--color-body-strong)] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        "[&_h1]:font-body [&_h2]:font-body [&_h3]:font-body [&_h4]:font-body [&_h1]:text-[17px] [&_h2]:text-[16px] [&_h3]:text-[15px] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold",
        "[&_li]:my-1 [&_ol]:pl-5 [&_ul]:pl-5 [&_p]:my-3",
        className,
      )}
      plugins={plugins}
      components={components}
      linkSafety={{ enabled: false }}
      isAnimating={streaming}
      animated={animation}
      mode={streaming ? "streaming" : "static"}
    >
      {children}
    </Streamdown>
  );
});
