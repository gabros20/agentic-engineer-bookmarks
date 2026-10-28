"use client";

import { BookOpenText, Eye, Film, Heart, Link2, Play, Star } from "lucide-react";
import { motion } from "motion/react";
import { memo, useMemo, useState, type CSSProperties } from "react";
import { postTime } from "@/lib/bookmark-filters";
import type { BookmarkPost } from "@/lib/bookmark-types";
import { useLanguage, type Lang } from "@/lib/i18n";

type BookmarkCardProps = {
  post: BookmarkPost;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  onOpen: (id: string) => void;
};

export type MediaEntry = NonNullable<BookmarkPost["media"]>[number];

export function postUrl(post: BookmarkPost) {
  return `https://x.com/${post.author.screenName}/status/${post.id}`;
}

export function openOnX(post: BookmarkPost) {
  window.open(postUrl(post), "_blank", "noopener,noreferrer");
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

// X text arrives HTML-escaped and ends in t.co links for the attached media/cards. Those links
// carry no information on their own (the media renders, real links are listed from `urls`).
export function cleanText(text: string) {
  return text
    .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s*https?:\/\/t\.co\/\w+/g, "")
    .trim();
}

const X_STATUS = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/\w+\/status\/\d+/i;

// Outbound links worth showing: not the X Article card, not links to other posts (quotes).
export function externalLinks(post: BookmarkPost) {
  return (post.urls ?? []).filter((url) => !url.includes("/i/article/") && !X_STATUS.test(url));
}

export function articleLink(post: BookmarkPost) {
  return (post.urls ?? []).find((url) => url.includes("/i/article/"));
}

export function displayHost(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname.replace(/\/$/, "");
    return path ? `${host}${path}` : host;
  } catch {
    return url;
  }
}

// Intl constructors are surprisingly expensive; cards format several values each render, so
// keep one formatter per (kind, lang) instead of constructing them per call.
const formatters = new Map<string, Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.DateTimeFormat>();
function cached<T extends Intl.NumberFormat | Intl.RelativeTimeFormat | Intl.DateTimeFormat>(key: string, make: () => T): T {
  let formatter = formatters.get(key) as T | undefined;
  if (!formatter) {
    formatter = make();
    formatters.set(key, formatter);
  }
  return formatter;
}

export function formatCompact(value: number | undefined, lang: Lang) {
  return cached(`compact:${lang}`, () => new Intl.NumberFormat(lang, { notation: "compact", maximumFractionDigits: 1 })).format(value ?? 0);
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// "3h", "2d", then "Oct 21" (this year) / "Oct 21, 2025".
export function shortDate(post: BookmarkPost, lang: Lang) {
  const time = postTime(post);
  if (!Number.isFinite(time) || time <= 0) return post.createdAtLocal ?? "";
  const diff = Date.now() - time;
  const relative = cached(`relative:${lang}`, () => new Intl.RelativeTimeFormat(lang, { numeric: "auto", style: "narrow" }));
  if (diff < DAY) return relative.format(-Math.max(1, Math.round(diff / HOUR)), "hour");
  if (diff < 7 * DAY) return relative.format(-Math.round(diff / DAY), "day");
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return cached(`short:${lang}:${sameYear}`, () =>
    new Intl.DateTimeFormat(lang, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) }),
  ).format(date);
}

export function longDate(post: BookmarkPost, lang: Lang) {
  const time = postTime(post);
  if (!Number.isFinite(time) || time <= 0) return post.createdAtLocal ?? "";
  return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeStyle: "short" }).format(new Date(time));
}

// pbs.twimg.com re-encodes only when BOTH params are set: format=webp alone still returns the
// original jpg. Measured: photo 124 KB jpg → small 32 KB / medium 80 KB / large 190 KB webp;
// video poster 107 KB → small 28 KB / medium 69 KB. small fits 680px, medium 1200, large 2048.
export function pbsVariant(url: string, name: "small" | "medium" | "large") {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "pbs.twimg.com") return url;
    parsed.searchParams.set("format", "webp");
    parsed.searchParams.set("name", name);
    return parsed.toString();
  } catch {
    return url;
  }
}

function pbsSrcSet(url: string, large = false) {
  const set = [`${pbsVariant(url, "small")} 680w`, `${pbsVariant(url, "medium")} 1200w`];
  if (large) set.push(`${pbsVariant(url, "large")} 2048w`);
  return set.join(", ");
}

// Natural aspect ratio from the stored dimensions, clamped so a panorama or a tall phone
// screenshot doesn't dominate the column.
export function mediaAspect(item: MediaEntry, min = 0.8, max = 1.91) {
  if (!item.width || !item.height) return 16 / 9;
  return Math.min(max, Math.max(min, item.width / item.height));
}

// Rough rendered height of a card at a column width, for masonry placement (components/
// masonry-grid.tsx). It mirrors the card layout below: media at its clamped aspect, clamped
// text lines, article title, link row, footer + metrics. Cached per post and width.
const heightCache = new WeakMap<BookmarkPost, { width: number; height: number }>();
export function estimateCardHeight(post: BookmarkPost, width: number) {
  const hit = heightCache.get(post);
  if (hit && Math.abs(hit.width - width) < 1) return hit.height;

  const media = post.media ?? [];
  const compact = Boolean(media.length || post.articleTitle);
  const textWidth = width - (width < 300 ? 24 : 32);
  let height = 0;
  if (media.length === 1) height += width / mediaAspect(media[0]);
  else if (media.length === 2) height += width / 2;
  else if (media.length > 2) height += width;

  if (post.articleTitle) {
    const titleLines = Math.min(4, Math.ceil(post.articleTitle.length / Math.max(10, textWidth / 10)));
    height += 24 + titleLines * (width < 300 ? 21 : 25);
  }
  const text = cleanText(post.text);
  if (text) {
    const charsPerLine = Math.max(14, textWidth / (compact ? 6.6 : 7.4));
    const wrapped = text.split("\n").reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
    const maxLines = compact ? 3 : width < 300 ? 7 : 9;
    height += Math.min(maxLines, wrapped) * (compact ? 19 : 22);
  }
  if (externalLinks(post).length) height += 24;
  height += 26 + 30; // padding + author row
  if (post.metrics?.likes || post.metrics?.views) height += 22;

  heightCache.set(post, { width, height });
  return height;
}

export const BookmarkCard = memo(function BookmarkCard({ post, isFavorite, onToggleFavorite, onOpen }: BookmarkCardProps) {
  const { t, lang } = useLanguage();
  const media = post.media ?? [];
  const text = useMemo(() => cleanText(post.text), [post.text]);
  const link = externalLinks(post)[0];
  const metrics = post.metrics ?? {};
  const compact = Boolean(media.length || post.articleTitle);

  return (
    <motion.article
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -8% 0px" }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      role="button"
      tabIndex={0}
      aria-label={`${t("card.open")}: ${post.author.name || post.author.screenName}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a,button,video")) return;
        // ⌘/Ctrl-click keeps the old jump-straight-to-X behaviour for power users.
        if (event.metaKey || event.ctrlKey) openOnX(post);
        else onOpen(post.id);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(post.id);
        }
      }}
      className="group relative block w-full min-w-0 cursor-pointer overflow-hidden rounded-2xl bg-[color:var(--color-canvas)] shadow-[0_1px_2px_rgb(0_0_0/0.04)] outline-none transition-[box-shadow,background-color] duration-300 hover:shadow-[var(--shadow-card-hover)] focus-visible:ring-2 focus-visible:ring-[color:var(--color-ink)]"
    >
      {media.length > 0 ? <MediaGrid media={media} /> : null}

      <div className="px-3 pb-3 pt-2.5 sm:px-4 sm:pb-3.5 sm:pt-3">
        {post.articleTitle ? (
          <div className="mb-1.5">
            <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[color:var(--color-muted)]">
              <BookOpenText size={12} />
              {t("detail.article")}
            </div>
            <h3 className="mt-1 font-display text-[19px] leading-[1.12] text-[color:var(--color-ink)] sm:text-[23px]">{post.articleTitle}</h3>
          </div>
        ) : null}

        {text ? (
          <p
            className={`whitespace-pre-line break-words text-[color:var(--color-body)] ${
              compact
                ? "line-clamp-3 text-[13px] leading-[1.45]"
                : "line-clamp-[7] text-[13.5px] leading-[1.5] text-[color:var(--color-body-strong)] sm:line-clamp-[9] sm:text-[15px]"
            }`}
          >
            {text}
          </p>
        ) : null}

        {link ? (
          <span className="mt-2 flex max-w-full items-center gap-1 text-[11px] text-[color:var(--color-muted)] sm:text-xs">
            <Link2 size={12} className="shrink-0" />
            <span className="truncate">{displayHost(link)}</span>
          </span>
        ) : null}

        <footer className="mt-2.5 flex min-w-0 items-center gap-1.5 text-[11px] text-[color:var(--color-muted)] sm:gap-2 sm:text-xs">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="size-[18px] shrink-0 rounded-full bg-[color:var(--color-hairline)] object-cover sm:size-5"
            src={post.author.profileImageUrl ?? ""}
            alt=""
            loading="lazy"
            decoding="async"
          />
          <span className="min-w-0 truncate font-medium text-[color:var(--color-body-strong)]">
            {post.author.name || post.author.screenName || "Unknown"}
          </span>
          <span className="ml-auto shrink-0 tabular-nums">{shortDate(post, lang)}</span>
        </footer>

        {metrics.likes || metrics.views ? (
          <div className="mt-1.5 flex items-center gap-3 text-[11px] tabular-nums text-[color:var(--color-muted-soft)]">
            {metrics.likes ? (
              <span className="inline-flex items-center gap-1" title={t("metric.likes")}>
                <Heart size={11} />
                {formatCompact(metrics.likes, lang)}
              </span>
            ) : null}
            {metrics.views ? (
              <span className="inline-flex items-center gap-1" title={t("metric.views")}>
                <Eye size={11} />
                {formatCompact(metrics.views, lang)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      <motion.button
        type="button"
        whileTap={{ scale: 0.85 }}
        aria-pressed={isFavorite}
        aria-label={isFavorite ? t("card.unstar") : t("card.star")}
        title={isFavorite ? t("card.unstar") : t("card.star")}
        onClick={() => onToggleFavorite(post.id)}
        className={`absolute right-2 top-2 grid size-8 place-items-center rounded-full bg-[color:var(--color-canvas)]/85 text-[color:var(--color-ink)] shadow-sm backdrop-blur transition-opacity duration-200 focus-visible:opacity-100 ${
          isFavorite ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:hidden"
        }`}
      >
        <Star size={15} strokeWidth={2.2} fill={isFavorite ? "currentColor" : "none"} />
      </motion.button>
    </motion.article>
  );
});

// Card media: one item at its natural (clamped) aspect, several in a tight 2-up grid.
// `detail` stacks every item full width, uncropped, at a larger size.
export function MediaGrid({ media, detail = false }: { media: MediaEntry[]; detail?: boolean }) {
  if (detail) {
    return (
      <div className="grid gap-2">
        {media.map((item, index) => {
          const style: CSSProperties = { aspectRatio: mediaAspect(item, 0.56, 2.4) };
          const className = "w-full rounded-xl bg-[color:var(--color-surface-card)] object-contain";
          if (item.type === "video" || item.type === "animated_gif") {
            return <VideoMedia key={`${item.url}-${index}`} item={item} className={className} style={style} sizes="(min-width: 640px) 36rem, 100vw" />;
          }
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${item.url}-${index}`}
              className={className}
              style={style}
              src={pbsVariant(item.url ?? "", "medium")}
              srcSet={item.url ? pbsSrcSet(item.url, true) : undefined}
              sizes="(min-width: 640px) 36rem, 100vw"
              alt=""
              decoding="async"
            />
          );
        })}
      </div>
    );
  }

  const items = media.slice(0, 4);
  const count = items.length;
  if (count === 1) {
    const item = items[0];
    const style: CSSProperties = { aspectRatio: mediaAspect(item) };
    return <MediaTile item={item} className="w-full" style={style} sizes="(min-width: 640px) 22rem, 50vw" />;
  }
  return (
    <div className="grid grid-cols-2 gap-0.5">
      {items.map((item, index) => (
        <MediaTile
          key={`${item.url}-${index}`}
          item={item}
          className={`w-full ${count === 3 && index === 0 ? "row-span-2 h-full" : "aspect-square"}`}
          sizes="(min-width: 640px) 11rem, 25vw"
        />
      ))}
    </div>
  );
}

function MediaTile({ item, className, style, sizes }: { item: MediaEntry; className: string; style?: CSSProperties; sizes: string }) {
  const base = `${className} min-h-0 bg-[color:var(--color-surface-cream-strong)] object-cover`;
  if (item.type === "video" || item.type === "animated_gif") {
    return <VideoMedia item={item} className={base} style={style} sizes={sizes} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`${base} transition-transform duration-500 ease-out group-hover:scale-[1.02]`}
      style={style}
      src={pbsVariant(item.url ?? "", "small")}
      srcSet={item.url ? pbsSrcSet(item.url) : undefined}
      sizes={sizes}
      alt=""
      loading="lazy"
      decoding="async"
    />
  );
}

function formatDuration(ms?: number) {
  if (!ms || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

// Poster (X's own still) with a play button; clicking swaps in an inline <video> on the stored mp4.
// video.twimg.com 403s a foreign Referer — playback relies on the app-wide Referrer-Policy:
// same-origin header (next.config.ts). If the mp4 is gone (deleted post), fall back to a
// placeholder; a click there bubbles to the card, which opens the detail view.
export function VideoMedia({
  item,
  className,
  style,
  sizes,
}: {
  item: MediaEntry;
  className: string;
  style?: CSSProperties;
  sizes: string;
}) {
  const { t } = useLanguage();
  const [playing, setPlaying] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const isGif = item.type === "animated_gif";
  const poster = item.thumbnail && !posterFailed ? item.thumbnail : undefined;
  const duration = isGif ? null : formatDuration(item.durationMs);

  if (playing && item.url && !videoFailed) {
    return (
      <video
        className={`${className} bg-black object-contain`}
        style={style}
        src={item.url}
        poster={poster ? pbsVariant(poster, "medium") : undefined}
        autoPlay
        playsInline
        controls={!isGif}
        loop={isGif}
        muted={isGif}
        onClick={isGif ? (event) => (event.currentTarget.paused ? event.currentTarget.play() : event.currentTarget.pause()) : undefined}
        onError={() => setVideoFailed(true)}
      />
    );
  }

  if (videoFailed || !item.url) {
    return (
      <div className={`${className} grid place-items-center`} style={style}>
        <div className="grid justify-items-center gap-1.5 px-3 text-center text-[color:var(--color-muted)]">
          <Film size={18} />
          <p className="max-w-40 text-[11px] leading-4">{t("media.unavailable")}</p>
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label={isGif ? t("media.playGif") : t("media.playVideo")}
      className={`${className} group/video relative grid place-items-center overflow-hidden`}
      style={style}
    >
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-out group-hover/video:scale-[1.03]"
          src={pbsVariant(poster, "small")}
          srcSet={pbsSrcSet(poster)}
          sizes={sizes}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setPosterFailed(true)}
        />
      ) : null}
      <span className="relative grid size-11 place-items-center rounded-full bg-black/55 text-white ring-1 ring-white/25 backdrop-blur-md transition duration-300 group-hover/video:scale-110 group-hover/video:bg-black/70">
        <Play size={18} fill="currentColor" className="translate-x-px" />
      </span>
      {duration || isGif ? (
        <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white backdrop-blur-sm">
          {duration ?? "GIF"}
        </span>
      ) : null}
    </button>
  );
}
