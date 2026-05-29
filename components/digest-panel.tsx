"use client";

import { experimental_useObject as useObject } from "@ai-sdk/react";
import { Loader2, RefreshCcw, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { digestSchema, type Digest, type DigestSource } from "@/lib/digest-schema";
import { getDigest, saveDigest, type SavedDigest } from "@/lib/digest-cache";
import { useLanguage } from "@/lib/i18n";

type Props = {
  open: boolean;
  query: string;
  sources?: DigestSource[];
  initialCached?: SavedDigest;
  onClose: () => void;
};

export function DigestPanel({ open, query, sources, initialCached, onClose }: Props) {
  const { lang, t } = useLanguage();
  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/digest",
    schema: digestSchema,
  });

  const [cached, setCached] = useState<SavedDigest | null>(null);
  const lastSubmittedRef = useRef<string | null>(null);
  const savedForRef = useRef<string | null>(null);

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
    const key = `${query}::${lang}::${sources.map((s) => s.id).join(",")}`;
    if (lastSubmittedRef.current === key) return;
    lastSubmittedRef.current = key;
    submit({ query, sources, language: lang });
  }, [open, query, sources, initialCached, submit, lang]);

  useEffect(() => {
    if (cached) return;
    if (isLoading || error) return;
    const themes = object?.themes;
    const overall = object?.overall;
    if (!themes?.length || !overall) return;
    const key = `${query}::done`;
    if (savedForRef.current === key) return;

    const sanitizedThemes: Digest["themes"] = themes
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .map((th) => ({
        title: th.title ?? "",
        summary: th.summary ?? "",
        sources: (th.sources ?? [])
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
  const sourceCount = cached ? cached.sourceCount : sources?.length ?? 0;
  const sourceLabel = sourceCount === 1 ? t("digest.sources", { n: 1 }) : t("digest.sourcesPlural", { n: sourceCount });

  function regenerate() {
    if (!sources?.length) return;
    setCached(null);
    savedForRef.current = null;
    lastSubmittedRef.current = `${query}::${lang}::${sources.map((s) => s.id).join(",")}::regen-${Date.now()}`;
    submit({ query, sources, language: lang });
  }

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-[color:var(--color-ink)]/30 backdrop-blur-sm"
        onClick={() => {
          stop();
          onClose();
        }}
      />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] shadow-[0_0_30px_rgba(20,20,19,0.08)] sm:w-[28rem]"
        role="dialog"
        aria-label={t("digest.title")}
      >
        <header className="flex items-center justify-between gap-3 border-b border-[color:var(--color-hairline)] px-4 py-3">
          <div className="flex items-center gap-2 text-[color:var(--color-ink)]">
            <Sparkles size={18} className="text-[color:var(--color-primary)]" />
            <h2 className="font-display text-[22px] leading-tight">{t("digest.title")}</h2>
            {isLoading ? <Loader2 size={14} className="animate-spin text-[color:var(--color-muted)]" /> : null}
            {display.mode === "cached" ? (
              <span className="rounded-full bg-[color:var(--color-surface-card)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-muted)]">{t("digest.savedBadge")}</span>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {canRegenerate && !isLoading ? (
              <button
                type="button"
                onClick={regenerate}
                title={t("digest.regenerateAria")}
                className="flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium text-[color:var(--color-muted)] transition hover:bg-[color:var(--color-surface-card)] hover:text-[color:var(--color-ink)]"
              >
                <RefreshCcw size={12} />
                {t("digest.regenerate")}
              </button>
            ) : null}
            <button
              type="button"
              aria-label={t("digest.aria.close")}
              onClick={() => {
                stop();
                onClose();
              }}
              className="grid h-8 w-8 place-items-center rounded-full text-[color:var(--color-muted)] transition hover:bg-[color:var(--color-surface-card)]"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div className="border-b border-[color:var(--color-hairline)] bg-[color:var(--color-surface-soft)] px-4 py-2 text-xs text-[color:var(--color-muted)]">
          <span className="font-semibold text-[color:var(--color-ink)]">{query}</span>
          {cached ? ` · ${sourceLabel} · ${t("digest.savedAge", { age: formatAge(cached.createdAt, t) })}` : ` · ${sourceLabel}`}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {error ? (
            <div className="rounded-lg border border-[color:var(--color-error)]/30 bg-[color:var(--color-error)]/5 p-3 text-sm text-[color:var(--color-error)]">
              {t("digest.error")} {error.message}
            </div>
          ) : null}

          {display.overall ? (
            <div className="mb-4 rounded-lg bg-[color:var(--color-primary)]/10 p-3 text-sm text-[color:var(--color-ink)]">
              <span className="font-semibold">{t("digest.startHere")}</span>
              {display.overall}
            </div>
          ) : null}

          {display.themes.length === 0 && isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-lg bg-[color:var(--color-surface-card)]" />
              ))}
            </div>
          ) : null}

          <ul className="space-y-4">
            {display.themes.map((theme, i) => (
              <li key={i} className="rounded-lg border border-[color:var(--color-hairline)] bg-[color:var(--color-surface-card)] p-4">
                <h3 className="font-display text-[18px] leading-snug text-[color:var(--color-ink)]">{theme?.title || "…"}</h3>
                {theme?.summary ? (
                  <p className="mt-1 text-[14px] leading-[1.55] text-[color:var(--color-body)]">{theme.summary}</p>
                ) : null}
                <ul className="mt-3 space-y-1">
                  {(theme?.sources ?? []).map((source, j) =>
                    source?.url ? (
                      <li key={j}>
                        <a
                          href={source.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block rounded-md border border-transparent px-2 py-2 transition hover:border-[color:var(--color-hairline)] hover:bg-[color:var(--color-canvas)]"
                        >
                          <div className="text-[12px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-primary)]">{source.author || "Source"}</div>
                          <div className="mt-0.5 text-[14px] leading-[1.55] text-[color:var(--color-ink)]">{source.gist || "…"}</div>
                        </a>
                      </li>
                    ) : null,
                  )}
                </ul>
              </li>
            ))}
          </ul>

          {!isLoading && display.themes.length === 0 && !error ? (
            <p className="py-8 text-center text-sm text-[color:var(--color-muted)]">{t("digest.empty")}</p>
          ) : null}
        </div>
      </aside>
    </>
  );
}

function formatAge(iso: string, t: ReturnType<typeof useLanguage>["t"]) {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return t("time.justNow");
  const min = Math.round(diff / 60000);
  if (min < 1) return t("time.justNow");
  if (min < 60) return t("time.minutes", { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("time.hours", { n: hr });
  const days = Math.round(hr / 24);
  if (days < 30) return t("time.days", { n: days });
  return new Date(iso).toLocaleDateString();
}
