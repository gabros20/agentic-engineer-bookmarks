"use client";

import { experimental_useObject as useObject } from "@ai-sdk/react";
import { Loader2, RefreshCcw, Sparkles, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { RemoveScroll } from "react-remove-scroll";
import { useEffect, useMemo, useRef, useState } from "react";
import { digestSchema, type Digest, type DigestSource } from "@/lib/digest-schema";
import { getDigest, saveDigest, type SavedDigest } from "@/lib/digest-cache";
import { useLanguage } from "@/lib/i18n";

type Props = {
  query: string;
  sources?: DigestSource[];
  initialCached?: SavedDigest;
  onClose: () => void;
};

export function DigestPanel({ query, sources, initialCached, onClose }: Props) {
  const { lang, t } = useLanguage();
  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/digest",
    schema: digestSchema,
  });

  const [cached, setCached] = useState<SavedDigest | null>(null);
  const lastSubmittedRef = useRef<string | null>(null);
  const savedForRef = useRef<string | null>(null);

  // The parent remounts this component (via `key`) per open, so this runs exactly once per session.
  useEffect(() => {
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
    const key = `${query}::${lang}::${sources.map((s) => s.id).join(",")}`;
    lastSubmittedRef.current = key;
    submit({ query, sources, language: lang });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cancel any in-flight stream when this instance unmounts.
  useEffect(() => {
    return () => stop();
  }, [stop]);

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

    const sanitizedReadFirst: Digest["readFirst"] = (object?.readFirst ?? [])
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .map((r) => ({
        bookmarkId: r.bookmarkId ?? "",
        author: r.author ?? "",
        why: r.why ?? "",
        url: r.url ?? "",
      }));

    const sanitizedDeeperReads: NonNullable<Digest["deeperReads"]> = (object?.deeperReads ?? [])
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map((d) => ({
        bookmarkId: d.bookmarkId ?? "",
        articleTitle: d.articleTitle ?? "",
        author: d.author ?? "",
        why: d.why ?? "",
        url: d.url ?? "",
      }));

    savedForRef.current = key;
    saveDigest({
      query,
      tldr: object?.tldr,
      themes: sanitizedThemes,
      overall,
      readFirst: sanitizedReadFirst,
      deeperReads: sanitizedDeeperReads.length ? sanitizedDeeperReads : undefined,
      sourceCount: sources?.length ?? 0,
      createdAt: new Date().toISOString(),
    });
  }, [object, isLoading, error, query, sources, cached]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        stop();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, stop]);

  const display = useMemo(() => {
    // Old saved entries (pre-T2) only ever had `themes`+`overall` in localStorage — `tldr`/
    // `readFirst`/`deeperReads` are `undefined` on them at runtime, so default to
    // absent/empty here rather than assume presence. That's the whole back-compat story:
    // no migration, just optional fields the render guards below already treat as "no
    // section".
    if (cached) {
      return {
        tldr: cached.tldr,
        overall: cached.overall,
        themes: cached.themes,
        readFirst: cached.readFirst ?? [],
        deeperReads: cached.deeperReads ?? [],
        mode: "cached" as const,
      };
    }
    return {
      tldr: object?.tldr,
      overall: object?.overall ?? "",
      themes: object?.themes ?? [],
      readFirst: object?.readFirst ?? [],
      deeperReads: object?.deeperReads ?? [],
      mode: "live" as const,
    };
  }, [cached, object]);

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
    <RemoveScroll>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-40 bg-[color:var(--color-ink)]/30 backdrop-blur-sm"
        onClick={() => {
          stop();
          onClose();
        }}
      />
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 360, damping: 40, mass: 0.8 }}
        style={{ paddingTop: "env(safe-area-inset-top)" }}
        className="fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] shadow-[0_0_30px_rgba(20,20,19,0.08)] sm:w-[28rem]"
        role="dialog"
        aria-label={t("digest.title")}
      >
        <div className="sm:hidden flex justify-center pt-2">
          <span className="h-1 w-9 rounded-full bg-[color:var(--color-hairline)]" aria-hidden />
        </div>

        <header className="flex items-center justify-between gap-3 border-b border-[color:var(--color-hairline)] px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2 text-[color:var(--color-ink)]">
            <Sparkles size={18} className="shrink-0 text-[color:var(--color-primary)]" />
            <h2 className="truncate font-display text-[22px] leading-tight">{t("digest.title")}</h2>
            {isLoading ? <Loader2 size={14} className="shrink-0 animate-spin text-[color:var(--color-muted)]" /> : null}
            {display.mode === "cached" ? (
              <span className="shrink-0 rounded-sm bg-[color:var(--color-surface-card)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-muted)]">{t("digest.savedBadge")}</span>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canRegenerate && !isLoading ? (
              <button
                type="button"
                onClick={regenerate}
                title={t("digest.regenerateAria")}
                className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-[color:var(--color-muted)] transition hover:bg-[color:var(--color-surface-card)] hover:text-[color:var(--color-ink)] sm:text-[11px]"
              >
                <RefreshCcw size={12} />
                <span className="hidden xs:inline sm:inline">{t("digest.regenerate")}</span>
              </button>
            ) : null}
            <button
              type="button"
              aria-label={t("digest.aria.close")}
              onClick={() => {
                stop();
                onClose();
              }}
              className="grid h-10 w-10 place-items-center rounded-full text-[color:var(--color-muted)] transition hover:bg-[color:var(--color-surface-card)] sm:h-8 sm:w-8"
            >
              <X size={20} className="sm:hidden" />
              <X size={18} className="hidden sm:block" />
            </button>
          </div>
        </header>

        <div className="border-b border-[color:var(--color-hairline)] bg-[color:var(--color-surface-soft)] px-4 py-2 text-xs text-[color:var(--color-muted)] sm:px-5">
          <span className="font-semibold text-[color:var(--color-ink)]">{query}</span>
          {cached ? ` · ${sourceLabel} · ${t("digest.savedAge", { age: formatAge(cached.createdAt, t) })}` : ` · ${sourceLabel}`}
        </div>

        <div
          className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
        >
          {error ? (
            <div className="rounded-lg border border-[color:var(--color-error)]/30 bg-[color:var(--color-error)]/5 p-3 text-sm text-[color:var(--color-error)]">
              {t("digest.error")} {error.message}
            </div>
          ) : null}

          <AnimatePresence>
            {/* New field — absent on OLD saved digests (pre-T2, themes+overall only). */}
            {display.tldr ? (
              <motion.div
                key="tldr"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
                className="mb-3 rounded-lg border border-[color:var(--color-primary)]/25 bg-[color:var(--color-surface-card)] p-3"
              >
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-primary)]">{t("digest.tldr")}</div>
                <p className="text-[15px] leading-[1.6] text-[color:var(--color-ink)]">{display.tldr}</p>
              </motion.div>
            ) : null}
          </AnimatePresence>

          <AnimatePresence>
            {display.overall ? (
              <motion.div
                key="overall"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
                className="mb-4 rounded-lg bg-[color:var(--color-primary)]/10 p-3 text-sm text-[color:var(--color-ink)]"
              >
                <span className="font-semibold">{t("digest.startHere")}</span>
                {display.overall}
              </motion.div>
            ) : null}
          </AnimatePresence>

          {display.themes.length === 0 && isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.06, duration: 0.25 }}
                  className="h-24 animate-pulse rounded-lg bg-[color:var(--color-surface-card)]"
                />
              ))}
            </div>
          ) : null}

          {display.themes.length > 0 ? (
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-muted)]">{t("digest.themes")}</h3>
          ) : null}

          <ul className="space-y-4">
            {display.themes.map((theme, i) => (
              <motion.li
                key={i}
                layout
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: "spring", stiffness: 380, damping: 32, delay: i * 0.04 }}
                className="rounded-lg border border-[color:var(--color-hairline)] bg-[color:var(--color-surface-card)] p-4"
              >
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
                          className="block rounded-md border border-transparent p-3 transition hover:border-[color:var(--color-hairline)] hover:bg-[color:var(--color-canvas)] sm:p-2"
                        >
                          <div className="text-[12px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-primary)]">{source.author || "Source"}</div>
                          <div className="mt-0.5 text-[14px] leading-[1.55] text-[color:var(--color-ink)]">{source.gist || "…"}</div>
                        </a>
                      </li>
                    ) : null,
                  )}
                </ul>
              </motion.li>
            ))}
          </ul>

          {/* New sections — absent (no heading, no crash) on OLD saved digests, whose
              `readFirst`/`deeperReads` default to `[]` in `display` above. Per-item `?.url`
              guards below mirror the theme-source guard for streaming-partial safety. */}
          {display.readFirst.some((item) => item?.url) ? (
            <div className="mt-6">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-muted)]">{t("digest.readFirst")}</h3>
              <ul className="space-y-1">
                {display.readFirst.map((item, i) =>
                  item?.url ? (
                    <motion.li
                      key={i}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ type: "spring", stiffness: 380, damping: 32, delay: i * 0.03 }}
                    >
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block rounded-md border border-transparent p-3 transition hover:border-[color:var(--color-hairline)] hover:bg-[color:var(--color-surface-card)] sm:p-2"
                      >
                        <div className="text-[12px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-primary)]">{item.author || "Source"}</div>
                        <div className="mt-0.5 text-[14px] leading-[1.55] text-[color:var(--color-ink)]">{item.why || "…"}</div>
                      </a>
                    </motion.li>
                  ) : null,
                )}
              </ul>
            </div>
          ) : null}

          {display.deeperReads.some((item) => item?.url) ? (
            <div className="mt-6">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-muted)]">{t("digest.deeperReads")}</h3>
              <ul className="space-y-1">
                {display.deeperReads.map((item, i) =>
                  item?.url ? (
                    <motion.li
                      key={i}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ type: "spring", stiffness: 380, damping: 32, delay: i * 0.03 }}
                    >
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block rounded-md border border-transparent p-3 transition hover:border-[color:var(--color-hairline)] hover:bg-[color:var(--color-surface-card)] sm:p-2"
                      >
                        <div className="text-[14px] font-medium leading-snug text-[color:var(--color-ink)]">{item.articleTitle || "…"}</div>
                        <div className="mt-0.5 text-[12px] font-semibold uppercase tracking-[1px] text-[color:var(--color-primary)]">{item.author || "Source"}</div>
                        <div className="mt-0.5 text-[13px] leading-[1.5] text-[color:var(--color-body)]">{item.why || "…"}</div>
                      </a>
                    </motion.li>
                  ) : null,
                )}
              </ul>
            </div>
          ) : null}

          {!isLoading && display.themes.length === 0 && !error ? (
            <p className="py-8 text-center text-sm text-[color:var(--color-muted)]">{t("digest.empty")}</p>
          ) : null}
        </div>
      </motion.aside>
    </RemoveScroll>
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
