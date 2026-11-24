"use client";

import { experimental_useObject as useObject } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Languages, RefreshCcw, Sparkles } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { IconButton, PanelBadge, PanelHeader } from "@/components/ui/panel-header";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import type { SavedDigest } from "@/lib/digest-cache";
import { digestSchema, type DigestSource } from "@/lib/digest-schema";
import { useLanguage } from "@/lib/i18n";
import { enter, stagger } from "@/lib/motion";
import { queryKeys } from "@/lib/queries";
import { fetchDigestByQuery } from "@/lib/digest-cache";
import { formatAge } from "@/lib/time";

// AI Digest: a reading brief for one search — TL;DR, where to start, themes with their sources,
// what to read first and the longer reads. It streams in section by section (each section rises
// in as it arrives), is persisted server-side on finish, and reopens from the DB next time.

type Props = {
  query: string;
  sources?: DigestSource[];
  initialCached?: SavedDigest;
  onClose: () => void;
};

export function DigestPanel({ query, sources, initialCached, onClose }: Props) {
  const { lang, t } = useLanguage();
  const queryClient = useQueryClient();

  // A 429 isn't a valid object stream, so the fetch flags it and the panel shows a localized
  // "daily limit reached" instead of a raw parse error.
  const [limitReached, setLimitReached] = useState(false);
  const quotaFetch = useCallback<typeof fetch>(async (input, init) => {
    setLimitReached(false);
    const res = await fetch(input, init);
    if (res.status === 429) setLimitReached(true);
    return res;
  }, []);

  const { object, submit, isLoading, error, stop } = useObject({
    api: "/api/digest",
    schema: digestSchema,
    fetch: quotaFetch,
    // The server saved it: every list and the by-query lookup refresh.
    onFinish: () => void queryClient.invalidateQueries({ queryKey: queryKeys.digests }),
  });

  const [cached, setCached] = useState<SavedDigest | null>(initialCached ?? null);
  // Looking up a previously generated digest before deciding to generate (no "empty" flash).
  const [checkingCache, setCheckingCache] = useState(!initialCached);

  const generate = useCallback(() => {
    if (!sources?.length) return;
    setCached(null);
    submit({ query, sources, language: lang });
  }, [query, sources, lang, submit]);

  // Once per open (the parent remounts per open): show the saved digest, or generate one.
  useEffect(() => {
    if (initialCached) return;
    let alive = true;
    queryClient
      .fetchQuery({ queryKey: queryKeys.digest(query), queryFn: () => fetchDigestByQuery(query) })
      .catch(() => null)
      .then((hit) => {
        if (!alive) return;
        setCheckingCache(false);
        if (hit) setCached(hit);
        else generate();
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => stop(), [stop]);

  const view = useMemo(
    () =>
      cached
        ? {
            tldr: cached.tldr,
            overall: cached.overall,
            themes: cached.themes,
            readFirst: cached.readFirst ?? [],
            deeperReads: cached.deeperReads ?? [],
          }
        : {
            tldr: object?.tldr,
            overall: object?.overall ?? "",
            themes: object?.themes ?? [],
            readFirst: object?.readFirst ?? [],
            deeperReads: object?.deeperReads ?? [],
          },
    [cached, object],
  );

  const canRegenerate = Boolean(sources?.length);
  const sourceCount = cached ? cached.sourceCount : (sources?.length ?? 0);
  const sourceLabel = sourceCount === 1 ? t("digest.sources", { n: 1 }) : t("digest.sourcesPlural", { n: sourceCount });
  const subtitle = [query, sourceLabel, cached ? t("digest.savedAge", { age: formatAge(cached.createdAt, t) }) : null].filter(Boolean).join(" · ");
  const otherLanguage = Boolean(cached?.language && cached.language !== lang);
  const waiting = (isLoading || checkingCache) && !view.tldr && view.themes.length === 0;
  const nothing = !isLoading && !checkingCache && view.themes.length === 0 && !view.tldr && !error && !limitReached;

  return (
    <ResponsivePanel
      title={t("digest.title")}
      onClose={() => {
        stop();
        onClose();
      }}
      className="h-[92dvh] sm:h-[min(48rem,88vh)] sm:max-w-2xl"
    >
      {(close) => (
        <>
          <PanelHeader
            icon={<Sparkles size={18} />}
            title={t("digest.title")}
            badge={cached ? <PanelBadge>{t("digest.savedBadge")}</PanelBadge> : null}
            subtitle={subtitle}
            closeLabel={t("digest.aria.close")}
            onClose={close}
            actions={
              canRegenerate && !isLoading ? (
                <IconButton label={t("digest.regenerateAria")} onClick={generate}>
                  <RefreshCcw size={17} />
                </IconButton>
              ) : null
            }
          />

          <div
            lang={cached?.language ?? lang}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-5 sm:px-6"
            style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1.5rem)" }}
          >
            {otherLanguage ? (
              <div className="mb-5 flex items-center gap-3 rounded-xl bg-[color:var(--color-surface-card)] py-2 pl-3 pr-2 text-[13.5px] text-[color:var(--color-body)]">
                <Languages size={15} className="shrink-0 text-[color:var(--color-muted)]" />
                <span className="min-w-0 flex-1">{t("digest.langNotice")}</span>
                {canRegenerate ? (
                  <button
                    type="button"
                    onClick={generate}
                    className="h-9 shrink-0 whitespace-nowrap rounded-full bg-[color:var(--color-canvas)] px-3.5 text-[13px] font-medium text-[color:var(--color-ink)] shadow-[0_1px_2px_rgb(0_0_0/0.06)] transition-transform active:scale-[0.97]"
                  >
                    {t("digest.rewrite")}
                  </button>
                ) : null}
              </div>
            ) : null}

            {limitReached || error ? (
              <p role="alert" className="mb-5 rounded-xl bg-[color:var(--color-error)]/8 p-3 text-[14px] text-[color:var(--color-error)]">
                {limitReached ? t("digest.limit") : t("digest.error")}
              </p>
            ) : null}

            {waiting ? <DigestSkeleton label={checkingCache ? null : t("digest.reading", { n: sourceCount })} /> : null}

            <AnimatePresence initial={!cached}>
              {view.tldr ? (
                <Section key="tldr">
                  <Eyebrow>{t("digest.tldr")}</Eyebrow>
                  <p className="text-read">{view.tldr}</p>
                </Section>
              ) : null}

              {view.overall ? (
                <Section key="overall">
                  <div className="flex gap-3 rounded-xl bg-[color:var(--color-surface-card)] p-3.5">
                    <ArrowRight size={16} className="mt-[5px] shrink-0 text-[color:var(--color-muted)] sm:mt-1.5" />
                    <p className="text-read-sm">
                      <span className="font-semibold text-[color:var(--color-ink)]">{t("digest.startHere")}</span>
                      {view.overall}
                    </p>
                  </div>
                </Section>
              ) : null}

              {view.themes.length ? (
                <Section key="themes">
                  <Eyebrow>{t("digest.themes")}</Eyebrow>
                  <ol className="space-y-9">
                    {view.themes.map((theme, i) => (
                      <motion.li key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: enter }}>
                        <div className="flex items-baseline gap-3">
                          <span className="shrink-0 text-[12px] font-medium tabular-nums text-[color:var(--color-muted-soft)]">
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <h3 className="min-w-0 text-balance font-display text-[22px] leading-[1.15] text-[color:var(--color-ink)] sm:text-[24px]">{theme?.title || "…"}</h3>
                        </div>
                        {theme?.summary ? <p className="mt-2 text-read-sm">{theme.summary}</p> : null}
                        <ul className="mt-3 divide-y divide-[color:var(--color-hairline)] border-y border-[color:var(--color-hairline)]">
                          {(theme?.sources ?? []).map((source, j) =>
                            source?.url ? (
                              <li key={j}>
                                <SourceLink href={source.url} author={source.author} body={source.gist} />
                              </li>
                            ) : null,
                          )}
                        </ul>
                      </motion.li>
                    ))}
                  </ol>
                </Section>
              ) : null}

              {view.readFirst.some((item) => item?.url) ? (
                <Section key="read-first">
                  <Eyebrow>{t("digest.readFirst")}</Eyebrow>
                  <ol className="divide-y divide-[color:var(--color-hairline)] border-y border-[color:var(--color-hairline)]">
                    {view.readFirst.map((item, i) =>
                      item?.url ? (
                        <li key={i}>
                          <SourceLink href={item.url} author={item.author} body={item.why} index={i} />
                        </li>
                      ) : null,
                    )}
                  </ol>
                </Section>
              ) : null}

              {view.deeperReads.some((item) => item?.url) ? (
                <Section key="deeper">
                  <Eyebrow>{t("digest.deeperReads")}</Eyebrow>
                  <ul className="divide-y divide-[color:var(--color-hairline)] border-y border-[color:var(--color-hairline)]">
                    {view.deeperReads.map((item, i) =>
                      item?.url ? (
                        <li key={i}>
                          <SourceLink href={item.url} title={item.articleTitle} author={item.author} body={item.why} />
                        </li>
                      ) : null,
                    )}
                  </ul>
                </Section>
              ) : null}
            </AnimatePresence>

            {isLoading && (view.tldr || view.themes.length) ? <p className="ai-shimmer mt-6 text-[13px]">{t("digest.writing")}</p> : null}

            {nothing ? <p className="py-12 text-center text-[14px] text-[color:var(--color-muted)]">{t("digest.empty")}</p> : null}
          </div>
        </>
      )}
    </ResponsivePanel>
  );
}

function Section({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.section initial={{ opacity: 0, y: reduce ? 0 : 10 }} animate={{ opacity: 1, y: 0, transition: enter }} className="mb-8 last:mb-0">
      {children}
    </motion.section>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <h3 className="font-body mb-2.5 text-[12px] font-medium text-[color:var(--color-muted)]">{children}</h3>;
}

function SourceLink({ href, author, body, title, index }: { href: string; author?: string; body?: string; title?: string; index?: number }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="-mx-2 flex gap-3 rounded-lg px-2 py-3 transition-colors hover:bg-[color:var(--color-surface-soft)] active:bg-[color:var(--color-surface-card)]"
    >
      {index !== undefined ? (
        <span className="mt-px shrink-0 text-[13px] font-medium leading-[1.5] tabular-nums text-[color:var(--color-muted-soft)]">{index + 1}</span>
      ) : null}
      <span className="min-w-0">
        {title ? <span className="block text-balance text-[16px] font-medium leading-snug text-[color:var(--color-ink)]">{title}</span> : null}
        <span className="block text-[13px] font-semibold text-[color:var(--color-ink)]">{author || "…"}</span>
        <span className="mt-0.5 block text-[15px] leading-[1.5] text-[color:var(--color-body)]">{body || "…"}</span>
      </span>
    </a>
  );
}

function DigestSkeleton({ label }: { label: string | null }) {
  return (
    <div aria-busy="true" className="space-y-6">
      {label ? (
        <p className="flex items-center gap-2 text-[13px]">
          <Sparkles size={14} className="text-[color:var(--color-muted)]" />
          <span className="ai-shimmer">{label}</span>
        </p>
      ) : null}
      <div className="space-y-2">
        {["w-full", "w-11/12", "w-4/6"].map((w, i) => (
          <motion.div
            key={w}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { ...enter, delay: stagger(i, 0.06) } }}
            className={`ai-skeleton h-4 rounded-md ${w}`}
          />
        ))}
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="space-y-2.5">
          <div className="ai-skeleton h-6 w-1/2 rounded-md" />
          <div className="ai-skeleton h-3.5 w-full rounded-md" />
          <div className="ai-skeleton h-3.5 w-5/6 rounded-md" />
        </div>
      ))}
    </div>
  );
}
