"use client";

import { ArrowUpRight, BadgeCheck, BookOpenText, Check, ChevronDown, ChevronLeft, ChevronRight, Link2, ListTree, Quote, Sparkles, Star, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cleanText,
  displayHost,
  externalLinks,
  formatCompact,
  longDate,
  openOnX,
  postUrl,
} from "@/components/bookmarks/bookmark-card";
import { DetailMedia } from "@/components/bookmarks/detail-media";
import { MediaLightbox } from "@/components/bookmarks/media-lightbox";
import { ResponsivePanel } from "@/components/ui/responsive-panel";
import type { BookmarkPost } from "@/lib/bookmark-types";
import { useLanguage, type MessageKey } from "@/lib/i18n";

type BookmarkDetailProps = {
  post: BookmarkPost;
  index: number;
  total: number;
  /** +1 when reached with "next", -1 with "previous": the content slides in from that side. */
  direction: number;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onAsk: (post: BookmarkPost) => void;
};

// The markdown renderer is only needed for X Articles; keep it out of the detail chunk.
const Streamdown = dynamic(() => import("streamdown").then((m) => m.Streamdown), {
  ssr: false,
  loading: () => <div className="h-24 animate-pulse rounded-lg bg-[color:var(--color-surface-card)]" />,
});

const METRICS: Array<{ key: keyof NonNullable<BookmarkPost["metrics"]>; label: MessageKey }> = [
  { key: "replies", label: "metric.replies" },
  { key: "retweets", label: "metric.reposts" },
  { key: "likes", label: "metric.likes" },
  { key: "bookmarks", label: "metric.bookmarks" },
  { key: "views", label: "metric.views" },
];

// Reading view for one bookmark, in a Revola responsive dialog: a modal on desktop, a Vaul
// bottom drawer on phones (swipe down to dismiss). ←/→ (or k/j) step through the result list.
export function BookmarkDetail({
  post,
  index,
  total,
  direction,
  isFavorite,
  onToggleFavorite,
  onClose,
  onPrev,
  onNext,
  onAsk,
}: BookmarkDetailProps) {
  const { t, lang } = useLanguage();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [articleOpen, setArticleOpen] = useState(false);
  // The media item open in the full-screen viewer: which gallery ("main" = the post itself,
  // else a thread post's id) and which item in it.
  const [viewing, setViewing] = useState<{ scope: string; index: number } | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setArticleOpen(false);
    setCopied(false);
    setViewing(null);
  }, [post.id]);

  const viewingScope = viewing?.scope;
  const mediaSource = useCallback(
    (i: number) =>
      scrollRef.current?.querySelector<HTMLElement>(
        `[data-post-id="${post.id}"] [data-media-scope="${viewingScope}"] [data-media-index="${i}"]`,
      ) ?? null,
    [post.id, viewingScope],
  );
  const viewingMedia =
    viewing === null ? undefined : viewing.scope === "main" ? post.media : post.thread?.find((p) => p.id === viewing.scope)?.media;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input,textarea,video,[contenteditable=true]")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft" || event.key === "k") onPrev();
      else if (event.key === "ArrowRight" || event.key === "j") onNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onPrev, onNext]);

  const text = cleanText(post.text);
  const links = externalLinks(post);
  const metrics = post.metrics ?? {};
  const quoted = post.quotedTweet;
  const quotedUrl = quoted?.id ? `https://x.com/${quoted.author?.screenName || "i"}/status/${quoted.id}` : undefined;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(postUrl(post));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked (permissions / insecure context): nothing useful to show.
    }
  }

  return (
    <ResponsivePanel
      title={post.author.name || post.author.screenName}
      onClose={onClose}
      className="h-[92dvh] sm:h-[min(54rem,90vh)] sm:max-w-2xl"
    >
      {(close) => (
        <>
          <div className="shrink-0">
            <div className="flex items-center gap-1 px-3 py-2 sm:px-5 sm:py-3">
              <span className="text-xs tabular-nums text-[color:var(--color-muted)]">
                {t("detail.position", { i: index + 1, n: total })}
              </span>
              <div className="ml-auto flex items-center gap-0.5">
                <IconButton label={t("detail.prev")} onClick={onPrev} disabled={index <= 0}>
                  <ChevronLeft size={18} />
                </IconButton>
                <IconButton label={t("detail.next")} onClick={onNext} disabled={index >= total - 1}>
                  <ChevronRight size={18} />
                </IconButton>
                <span className="mx-1 h-5 w-px bg-[color:var(--color-hairline)]" aria-hidden />
                <IconButton label={t("detail.close")} onClick={close}>
                  <X size={18} />
                </IconButton>
              </div>
            </div>
          </div>

          <div ref={scrollRef} data-detail-scroll className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <AnimatePresence mode="popLayout" initial={false} custom={direction}>
              <motion.div
                key={post.id}
                custom={direction}
                initial={{ opacity: 0, x: direction * 28 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: direction * -28 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                data-post-id={post.id}
                className="px-5 pb-8 pt-2 sm:px-8 sm:pt-4"
              >
                <header className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="size-11 shrink-0 rounded-full bg-[color:var(--color-hairline)] object-cover"
                    src={post.author.profileImageUrl ?? ""}
                    alt=""
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1 font-semibold text-[color:var(--color-ink)]">
                      <span className="truncate">{post.author.name || post.author.screenName}</span>
                      {post.author.verified ? <BadgeCheck size={16} className="shrink-0 text-[color:var(--color-muted)]" /> : null}
                    </div>
                    <div className="truncate text-sm text-[color:var(--color-muted)]">
                      @{post.author.screenName} · {longDate(post, lang)}
                    </div>
                  </div>
                </header>

                {post.articleTitle ? (
                  <h2 className="mt-6 font-display text-[30px] leading-[1.08] text-[color:var(--color-ink)] sm:text-[38px]">{post.articleTitle}</h2>
                ) : null}

                {text ? (
                  <p lang={contentLang(post.lang)} className="mt-5 whitespace-pre-line text-read">
                    {text}
                  </p>
                ) : null}

                {post.media?.length ? (
                  <div className="mt-5">
                    <DetailMedia media={post.media} scope="main" onOpenMedia={(index) => setViewing({ scope: "main", index })} />
                  </div>
                ) : null}

                {post.articleText ? (
                  <section className="mt-7 border-t border-[color:var(--color-hairline)] pt-5">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">
                      <BookOpenText size={13} />
                      {t("detail.article")}
                    </div>
                    <div className={`relative mt-4 ${articleOpen ? "" : "max-h-96 overflow-hidden"}`}>
                      <div lang={contentLang(post.lang)} className="text-read [&_a]:text-[color:var(--color-ink)] [&_a]:underline [&_a]:decoration-[color:var(--color-muted-soft)] [&_a]:underline-offset-[3px]">
                        <Streamdown className="prose-read">{post.articleText}</Streamdown>
                      </div>
                      {articleOpen ? null : (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-[color:var(--color-canvas)] to-transparent" />
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setArticleOpen((open) => !open)}
                      className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[color:var(--color-ink)] hover:underline"
                    >
                      {articleOpen ? t("detail.readLess") : t("detail.readMore")}
                      <ChevronDown size={15} className={`transition-transform ${articleOpen ? "rotate-180" : ""}`} />
                    </button>
                  </section>
                ) : null}

                {quoted?.text ? (
                  <a
                    href={quotedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-6 block rounded-2xl p-4 ring-1 ring-[color:var(--color-hairline)] transition hover:bg-[color:var(--color-surface-soft)]"
                  >
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">
                      <Quote size={12} />
                      {t("detail.quoted")}
                    </div>
                    <div className="mt-2 text-sm font-semibold text-[color:var(--color-ink)]">
                      {quoted.author?.name}{" "}
                      <span className="font-normal text-[color:var(--color-muted)]">@{quoted.author?.screenName}</span>
                    </div>
                    <p className="mt-1 line-clamp-6 whitespace-pre-line break-words text-[15px] leading-[1.55] text-[color:var(--color-body)]">
                      {cleanText(quoted.text)}
                    </p>
                  </a>
                ) : null}

                {post.thread?.length ? (
                  <ThreadSection
                    thread={post.thread}
                    label={t("detail.thread", { n: post.thread.length + 1 })}
                    onOpenMedia={(scope, index) => setViewing({ scope, index })}
                  />
                ) : null}

                {links.length ? (
                  <section className="mt-6">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]" style={{ fontFamily: "inherit" }}>
                      {t("detail.links")}
                    </h3>
                    <ul className="mt-2 grid gap-1">
                      {links.map((url) => (
                        <li key={url}>
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="group/link flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-[color:var(--color-hairline-soft)] transition hover:bg-[color:var(--color-surface-card)]"
                          >
                            <Link2 size={15} className="shrink-0 text-[color:var(--color-muted)]" />
                            <span className="min-w-0 flex-1 truncate text-sm text-[color:var(--color-ink)]">{displayHost(url)}</span>
                            <ArrowUpRight size={15} className="shrink-0 text-[color:var(--color-muted)] transition group-hover/link:-translate-y-0.5 group-hover/link:translate-x-0.5" />
                          </a>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}

                <dl className="mt-6 grid grid-cols-5 divide-x divide-[color:var(--color-hairline-soft)] rounded-2xl bg-[color:var(--color-surface-soft)] py-3 ring-1 ring-[color:var(--color-hairline-soft)]">
                  {METRICS.map(({ key, label }) => (
                    <div key={key} className="min-w-0 px-1 text-center" title={new Intl.NumberFormat(lang).format(metrics[key] ?? 0)}>
                      <dd className="text-[15px] font-semibold tabular-nums text-[color:var(--color-ink)] sm:text-[17px]">
                        {formatCompact(metrics[key], lang)}
                      </dd>
                      <dt className="mt-0.5 truncate text-[10px] text-[color:var(--color-muted)] sm:text-[11px]">{t(label)}</dt>
                    </div>
                  ))}
                </dl>
              </motion.div>
            </AnimatePresence>
          </div>

          <footer
            className="flex shrink-0 items-center gap-2 border-t border-[color:var(--color-hairline-soft)] bg-[color:var(--color-canvas)] px-4 pt-3 sm:px-8"
            style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
          >
            <motion.button
              type="button"
              whileTap={{ scale: 0.97 }}
              onClick={() => openOnX(post)}
              className="flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-[color:var(--color-primary)] px-4 text-sm font-medium text-[color:var(--color-on-primary)] transition-colors hover:bg-[color:var(--color-primary-active)] max-[359px]:px-3"
            >
              <span className="truncate">{t("detail.openOnX")}</span>
              <ArrowUpRight size={16} className="shrink-0 max-[359px]:hidden" />
            </motion.button>
            <FooterButton
              label={isFavorite ? t("card.unstar") : t("card.star")}
              pressed={isFavorite}
              onClick={() => onToggleFavorite(post.id)}
            >
              <Star size={17} strokeWidth={2.1} fill={isFavorite ? "currentColor" : "none"} />
            </FooterButton>
            <FooterButton label={copied ? t("detail.copied") : t("detail.copyLink")} onClick={copyLink}>
              {copied ? <Check size={17} /> : <Link2 size={17} />}
            </FooterButton>
            <FooterButton label={t("detail.ask")} onClick={() => onAsk(post)}>
              <Sparkles size={17} />
            </FooterButton>
          </footer>

          {viewing !== null && viewingMedia?.length ? (
            <MediaLightbox
              key={viewing.scope}
              media={viewingMedia}
              initialIndex={viewing.index}
              getSource={mediaSource}
              onClose={() => setViewing(null)}
            />
          ) : null}
        </>
      )}
    </ResponsivePanel>
  );
}

/** X's language tag for a post, as a lang attribute (drives hyphenation + screen-reader voice).
 *  X also uses non-language tags ("und", "zxx", "qme"…), which are left out. */
function contentLang(code: string | undefined) {
  return code && /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(code) ? code : undefined;
}

/**
 * The author's own continuation of the post (xrelay archive --threads), read like X shows
 * it: one post after another on a thin rail, each with its own media (same layout + viewer).
 */
function ThreadSection({
  thread,
  label,
  onOpenMedia,
}: {
  thread: BookmarkPost[];
  label: string;
  onOpenMedia: (scope: string, index: number) => void;
}) {
  return (
    <section className="mt-7" aria-label={label}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">
        <ListTree size={13} />
        {label}
      </div>
      <ol className="mt-4">
        {thread.map((item, i) => {
          const body = cleanText(item.text);
          const last = i === thread.length - 1;
          return (
            <li key={item.id} className={`relative pl-7 ${last ? "" : "pb-7"}`}>
              {last ? null : <span aria-hidden className="absolute bottom-0 left-[4px] top-4 w-px bg-[color:var(--color-hairline)]" />}
              <span aria-hidden className="absolute left-0 top-[9px] size-[9px] rounded-full bg-[color:var(--color-muted-soft)] ring-4 ring-[color:var(--color-canvas)]" />
              {body ? (
                <p lang={contentLang(item.lang)} className="whitespace-pre-line text-read">
                  {body}
                </p>
              ) : null}
              {item.media?.length ? (
                <div className={body ? "mt-4" : ""}>
                  <DetailMedia media={item.media} scope={item.id} bleed={false} onOpenMedia={(index) => onOpenMedia(item.id, index)} />
                </div>
              ) : null}
              {item.quotedTweet?.text ? (
                <p className="mt-3 line-clamp-4 whitespace-pre-line break-words rounded-xl px-3 py-2 text-[15px] leading-[1.5] text-[color:var(--color-body)] ring-1 ring-[color:var(--color-hairline)]">
                  <span className="font-semibold text-[color:var(--color-ink)]">@{item.quotedTweet.author?.screenName}</span> {cleanText(item.quotedTweet.text)}
                </p>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="touch-target relative grid size-10 shrink-0 place-items-center rounded-full text-[color:var(--color-ink)] transition hover:bg-[color:var(--color-surface-card)] disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}

function FooterButton({ label, onClick, pressed, children }: { label: string; onClick: () => void; pressed?: boolean; children: React.ReactNode }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.9 }}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      onClick={onClick}
      className="grid size-11 shrink-0 place-items-center rounded-full text-[color:var(--color-ink)] ring-1 ring-[color:var(--color-hairline)] transition hover:bg-[color:var(--color-surface-card)]"
    >
      {children}
    </motion.button>
  );
}
