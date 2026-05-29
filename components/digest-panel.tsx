"use client";

import { experimental_useObject as useObject } from "@ai-sdk/react";
import { Loader2, Sparkles, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { digestSchema, type DigestSource } from "@/lib/digest-schema";

type Props = {
  open: boolean;
  query: string;
  sources: DigestSource[];
  onClose: () => void;
};

export function DigestPanel({ open, query, sources, onClose }: Props) {
  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/digest",
    schema: digestSchema,
  });

  const submittedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const key = `${query}::${sources.map((s) => s.id).join(",")}`;
    if (submittedRef.current === key) return;
    submittedRef.current = key;
    submit({ query, sources });
  }, [open, query, sources, submit]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        stop();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, stop]);

  if (!open) return null;

  const themes = object?.themes ?? [];

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={() => {
          stop();
          onClose();
        }}
      />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col bg-white shadow-2xl ring-1 ring-[#eff3f4] sm:w-[28rem]"
        role="dialog"
        aria-label="AI digest"
      >
        <header className="flex items-center justify-between gap-3 border-b border-[#eff3f4] px-4 py-3">
          <div className="flex items-center gap-2 text-[#0f1419]">
            <Sparkles size={18} className="text-[#1d9bf0]" />
            <h2 className="text-base font-extrabold">AI Digest</h2>
            {isLoading ? <Loader2 size={14} className="animate-spin text-[#536471]" /> : null}
          </div>
          <button
            type="button"
            aria-label="Close digest"
            onClick={() => {
              stop();
              onClose();
            }}
            className="grid h-8 w-8 place-items-center rounded-full text-[#536471] transition hover:bg-[#eff3f4]"
          >
            <X size={18} />
          </button>
        </header>

        <div className="border-b border-[#eff3f4] bg-[#f7f9f9] px-4 py-2 text-xs text-[#536471]">
          <span className="font-bold text-[#0f1419]">{query}</span> · {sources.length} source{sources.length === 1 ? "" : "s"}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Could not generate digest. {error.message}
            </div>
          ) : null}

          {object?.overall ? (
            <div className="mb-4 rounded-2xl bg-[#1d9bf0]/10 p-3 text-sm text-[#0f1419]">
              <span className="font-bold">Where to start: </span>
              {object.overall}
            </div>
          ) : null}

          {themes.length === 0 && isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-2xl bg-[#eff3f4]" />
              ))}
            </div>
          ) : null}

          <ul className="space-y-4">
            {themes.map((theme, i) => (
              <li key={i} className="rounded-2xl border border-[#eff3f4] bg-white p-3">
                <h3 className="text-sm font-extrabold text-[#0f1419]">{theme?.title || "…"}</h3>
                {theme?.summary ? (
                  <p className="mt-1 text-[13px] leading-5 text-[#536471]">{theme.summary}</p>
                ) : null}
                <ul className="mt-3 space-y-2">
                  {(theme?.sources ?? []).map((source, j) =>
                    source?.url ? (
                      <li key={j}>
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block rounded-xl border border-transparent px-2 py-2 transition hover:border-[#cfd9de] hover:bg-[#f7f9f9]"
                        >
                          <div className="text-[12px] font-bold text-[#1d9bf0]">{source.author || "Source"}</div>
                          <div className="mt-0.5 text-[13px] leading-5 text-[#0f1419]">{source.gist || "…"}</div>
                        </a>
                      </li>
                    ) : null,
                  )}
                </ul>
              </li>
            ))}
          </ul>

          {!isLoading && themes.length === 0 && !error ? (
            <p className="py-8 text-center text-sm text-[#536471]">No digest yet.</p>
          ) : null}
        </div>
      </aside>
    </>
  );
}
