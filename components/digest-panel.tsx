"use client";

import { experimental_useObject as useObject } from "@ai-sdk/react";
import { Loader2, RefreshCcw, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { digestSchema, type Digest, type DigestSource } from "@/lib/digest-schema";
import { getDigest, saveDigest, type SavedDigest } from "@/lib/digest-cache";

type Props = {
  open: boolean;
  query: string;
  /** Sources to digest. Required for live mode (regenerate). Omit for history mode. */
  sources?: DigestSource[];
  /** Pre-loaded cached digest (history mode). When set, the panel skips the API call until Regenerate is pressed. */
  initialCached?: SavedDigest;
  onClose: () => void;
};

export function DigestPanel({ open, query, sources, initialCached, onClose }: Props) {
  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/digest",
    schema: digestSchema,
  });

  const [cached, setCached] = useState<SavedDigest | null>(null);
  const lastSubmittedRef = useRef<string | null>(null);
  const savedForRef = useRef<string | null>(null);

  // On open: resolve cache. Prefer initialCached prop, else look up by query, else submit.
  useEffect(() => {
    if (!open) return;
    if (initialCached) {
      setCached(initialCached);
      return;
    }
    const hit = getDigest(query);
    if (hit) {
      setCached(hit);
      return;
    }
    if (!sources?.length) return;
    setCached(null);
    const key = `${query}::${sources.map((s) => s.id).join(",")}`;
    if (lastSubmittedRef.current === key) return;
    lastSubmittedRef.current = key;
    submit({ query, sources });
  }, [open, query, sources, initialCached, submit]);

  // Save on stream completion.
  useEffect(() => {
    if (cached) return;
    if (isLoading || error) return;
    const themes = object?.themes;
    const overall = object?.overall;
    if (!themes?.length || !overall) return;
    const key = `${query}::done`;
    if (savedForRef.current === key) return;

    // Coerce streamed partials (which can be undefined) into a fully-typed Digest before saving.
    const sanitizedThemes: Digest["themes"] = themes
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .map((t) => ({
        title: t.title ?? "",
        summary: t.summary ?? "",
        sources: (t.sources ?? [])
          .filter((s): s is NonNullable<typeof s> => Boolean(s))
          .map((s) => ({
            bookmarkId: s.bookmarkId ?? "",
            author: s.author ?? "",
            gist: s.gist ?? "",
            url: s.url ?? "",
          })),
      }));

    savedForRef.current = key;
    saveDigest({
      query,
      themes: sanitizedThemes,
      overall,
      sourceCount: sources?.length ?? 0,
      createdAt: new Date().toISOString(),
    });
  }, [object, isLoading, error, query, sources, cached]);

  // Esc to close.
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

  const display = useMemo(() => {
    if (cached) return { themes: cached.themes, overall: cached.overall, mode: "cached" as const };
    return { themes: object?.themes ?? [], overall: object?.overall ?? "", mode: "live" as const };
  }, [cached, object]);

  if (!open) return null;

  const canRegenerate = Boolean(sources?.length);

  function regenerate() {
    if (!sources?.length) return;
    setCached(null);
    savedForRef.current = null;
    lastSubmittedRef.current = `${query}::${sources.map((s) => s.id).join(",")}::regen-${Date.now()}`;
    submit({ query, sources });
  }

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
            {display.mode === "cached" ? (
              <span className="rounded-full bg-[#eff3f4] px-2 py-0.5 text-[10px] font-bold text-[#536471]">SAVED</span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {canRegenerate && !isLoading ? (
              <button
                type="button"
                onClick={regenerate}
                title="Regenerate with current top results"
                className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold text-[#536471] transition hover:bg-[#eff3f4] hover:text-[#0f1419]"
              >
                <RefreshCcw size={12} />
                Regenerate
              </button>
            ) : null}
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
          </div>
        </header>

        <div className="border-b border-[#eff3f4] bg-[#f7f9f9] px-4 py-2 text-xs text-[#536471]">
          <span className="font-bold text-[#0f1419]">{query}</span>
          {cached ? ` · ${cached.sourceCount} source${cached.sourceCount === 1 ? "" : "s"} · saved ${formatAge(cached.createdAt)}`
            : ` · ${sources?.length ?? 0} source${(sources?.length ?? 0) === 1 ? "" : "s"}`}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Could not generate digest. {error.message}
            </div>
          ) : null}

          {display.overall ? (
            <div className="mb-4 rounded-2xl bg-[#1d9bf0]/10 p-3 text-sm text-[#0f1419]">
              <span className="font-bold">Where to start: </span>
              {display.overall}
            </div>
          ) : null}

          {display.themes.length === 0 && isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-2xl bg-[#eff3f4]" />
              ))}
            </div>
          ) : null}

          <ul className="space-y-4">
            {display.themes.map((theme, i) => (
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

          {!isLoading && display.themes.length === 0 && !error ? (
            <p className="py-8 text-center text-sm text-[#536471]">No digest yet.</p>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function formatAge(iso: string) {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
