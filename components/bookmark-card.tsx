"use client";

import { BarChart3, BookOpenText, Film, Heart, MessageCircle, PlayCircle, Repeat2, Star } from "lucide-react";
import { useState } from "react";
import type { BookmarkPost } from "@/lib/bookmark-types";

type BookmarkCardProps = {
  post: BookmarkPost;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
};

const formatter = new Intl.NumberFormat("en");

function formatNumber(value?: number) {
  return formatter.format(value ?? 0);
}

function postUrl(post: BookmarkPost) {
  return `https://x.com/${post.author.screenName}/status/${post.id}`;
}

function openPost(post: BookmarkPost) {
  window.open(postUrl(post), "_blank", "noopener,noreferrer");
}

export function BookmarkCard({ post, isFavorite, onToggleFavorite }: BookmarkCardProps) {
  const metrics = post.metrics ?? {};
  const date = post.createdAtLocal ?? post.createdAtISO ?? post.createdAt ?? "";
  const media = post.media ?? [];
  const articleUrl = (post.urls ?? []).find((url) => url.includes("/i/article/"));
  const visibleUrls = (post.urls ?? []).filter((url) => url !== articleUrl).slice(0, 2);

  return (
    <article
      role="link"
      tabIndex={0}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("a,button,video")) return;
        openPost(post);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") openPost(post);
      }}
      className="group mb-3 inline-block w-full min-w-0 cursor-pointer break-inside-avoid rounded-xl border border-[color:var(--color-hairline)] bg-[color:var(--color-surface-soft)] px-3 py-3 align-top transition hover:bg-[color:var(--color-surface-card)] sm:mb-4 sm:px-4"
    >
      <div className="min-w-0">
        <div className="grid min-w-0 grid-cols-[36px_1fr] gap-2 sm:grid-cols-[40px_1fr]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="size-9 rounded-full bg-[color:var(--color-hairline)] object-cover sm:size-10"
            src={post.author.profileImageUrl ?? ""}
            alt=""
          />
          <div className="flex min-w-0 flex-wrap items-start gap-x-1 text-[13px] leading-5 sm:text-[14px]">
            <span className="truncate font-semibold text-[color:var(--color-ink)]">{post.author.name || "Unknown"}</span>
            <span className="truncate text-[color:var(--color-muted)]">@{post.author.screenName || "unknown"}</span>
            <span className="text-[color:var(--color-muted-soft)]">·</span>
            <time className="text-[color:var(--color-muted)]">{date}</time>
          </div>
        </div>

        <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-[1.55] text-[color:var(--color-body)] sm:text-[14px]">{post.text}</p>

        {media.length > 0 ? <MediaGrid media={media} /> : null}

        {post.articleTitle ? <ArticlePreview title={post.articleTitle} url={articleUrl} /> : null}

        {visibleUrls.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {visibleUrls.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="max-w-full truncate rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-2.5 py-1 text-xs text-[color:var(--color-primary)] hover:bg-[color:var(--color-surface-cream-strong)]"
              >
                {url}
              </a>
            ))}
          </div>
        ) : null}

        <div className="mt-2 flex items-center justify-between text-[color:var(--color-muted)]">
          <Metric icon={<MessageCircle size={14} />} value={metrics.replies} />
          <Metric icon={<Repeat2 size={14} />} value={metrics.retweets} />
          <Metric icon={<Heart size={14} />} value={metrics.likes} />
          <Metric icon={<BarChart3 size={14} />} value={metrics.views} />
          <button
            type="button"
            aria-pressed={isFavorite}
            onClick={() => onToggleFavorite(post.id)}
            className={[
              "inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-full px-1.5 text-xs transition",
              isFavorite
                ? "text-[color:var(--color-primary)] hover:bg-[color:var(--color-primary)]/10"
                : "text-[color:var(--color-muted)] hover:bg-[color:var(--color-primary)]/10 hover:text-[color:var(--color-primary)]",
            ].join(" ")}
            title={isFavorite ? "Remove star" : "Star"}
          >
            <Star size={16} strokeWidth={2.2} fill={isFavorite ? "currentColor" : "none"} />
            <span className="sr-only">{isFavorite ? "Starred" : "Star"}</span>
          </button>
        </div>
      </div>
    </article>
  );
}

function ArticlePreview({ title, url }: { title: string; url?: string }) {
  const content = (
    <>
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[1.5px] text-[color:var(--color-muted)]">
        <BookOpenText size={14} />
        X Article
      </div>
      <div className="mt-1 font-display text-[18px] leading-snug text-[color:var(--color-ink)]">{title}</div>
      {url ? <div className="mt-1 truncate text-xs text-[color:var(--color-primary)]">{url}</div> : null}
    </>
  );

  if (!url) {
    return (
      <div className="mt-3 rounded-lg border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-3">
        {content}
      </div>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-3 block rounded-lg border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-3 transition hover:bg-[color:var(--color-surface-cream-strong)]"
    >
      {content}
    </a>
  );
}

function Metric({ icon, value }: { icon: React.ReactNode; value?: number }) {
  return (
    <span className="inline-flex h-7 items-center gap-1 rounded-full px-1.5 text-[11px] transition hover:bg-[color:var(--color-primary)]/10 hover:text-[color:var(--color-primary)] sm:h-8 sm:text-xs">
      {icon}
      <span>{formatNumber(value)}</span>
    </span>
  );
}

function MediaGrid({ media }: { media: NonNullable<BookmarkPost["media"]> }) {
  const items = media.slice(0, 4);
  const count = items.length;
  const gridClass = count === 1 ? "grid-cols-1" : "grid-cols-2";

  return (
    <div className={`mt-3 grid overflow-hidden rounded-lg border border-[color:var(--color-hairline)] bg-[color:var(--color-surface-cream-strong)] ${gridClass}`}>
      {items.map((item, index) => (
        <MediaItem key={`${item.url}-${index}`} item={item} count={count} index={index} />
      ))}
    </div>
  );
}

function MediaItem({
  item,
  count,
  index,
}: {
  item: NonNullable<BookmarkPost["media"]>[number];
  count: number;
  index: number;
}) {
  const isVideo = item.type === "video" || item.type === "animated_gif";
  const single = count === 1;
  const tallThird = count === 3 && index === 0;

  const className = [
    "min-h-0 w-full bg-[color:var(--color-surface-cream-strong)] object-cover",
    single ? "max-h-[360px] aspect-video" : "aspect-square border-[color:var(--color-hairline)]",
    count > 1 && index % 2 === 1 ? "border-l" : "",
    count > 2 && index > 1 ? "border-t" : "",
    tallThird ? "row-span-2 h-full" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (isVideo) return <VideoMedia item={item} className={className} />;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={className}
      src={item.url}
      alt=""
      loading="lazy"
    />
  );
}

type MediaEntry = NonNullable<BookmarkPost["media"]>[number];

// X's poster CDN only re-encodes when BOTH params are set: format=webp alone still returns the
// ~107 KB jpg, format=webp&name=small is ~28 KB (fits 680px), name=medium ~69 KB (fits 1200px).
function posterVariant(url: string, name: "small" | "medium") {
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
// same-origin header (next.config.ts). If the mp4 is gone (deleted post), fall back to the
// placeholder; a click there bubbles to the card and opens the post on X.
function VideoMedia({ item, className }: { item: MediaEntry; className: string }) {
  const [playing, setPlaying] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const isGif = item.type === "animated_gif";
  const label = isGif ? "GIF on X" : "Video on X";
  const poster = item.thumbnail && !posterFailed ? item.thumbnail : undefined;
  const duration = isGif ? null : formatDuration(item.durationMs);

  if (playing && item.url && !videoFailed) {
    return (
      <video
        className={`${className} bg-black object-contain`}
        src={item.url}
        poster={poster ? posterVariant(poster, "medium") : undefined}
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

  const placeholder = (
    <div className="grid justify-items-center gap-1.5 px-3 text-center text-[color:var(--color-muted)]">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-[color:var(--color-surface-dark)]/90 text-[color:var(--color-on-dark)] shadow-sm">
        <PlayCircle size={24} strokeWidth={2.2} />
      </div>
      <div className="flex items-center gap-1.5 text-xs font-semibold text-[color:var(--color-ink)]">
        <Film size={14} />
        {label}
      </div>
      {videoFailed ? <p className="max-w-36 text-[11px] leading-4">Open the post to watch.</p> : null}
    </div>
  );

  if (videoFailed || !item.url) {
    return (
      <div className={`${className} flex items-center justify-center`} aria-label={label}>
        {placeholder}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setPlaying(true)}
      aria-label={`Play ${isGif ? "GIF" : "video"}`}
      className={`${className} group/video relative flex items-center justify-center overflow-hidden`}
    >
      {poster ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="absolute inset-0 h-full w-full object-cover"
            src={posterVariant(poster, "small")}
            srcSet={`${posterVariant(poster, "small")} 680w, ${posterVariant(poster, "medium")} 1200w`}
            sizes="(min-width: 1024px) 34vw, (min-width: 640px) 50vw, 100vw"
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setPosterFailed(true)}
          />
          <span className="relative grid h-12 w-12 place-items-center rounded-full bg-black/60 text-white shadow-md ring-1 ring-white/30 backdrop-blur-sm transition group-hover/video:scale-105 group-hover/video:bg-black/75">
            <PlayCircle size={26} strokeWidth={2.2} />
          </span>
          {duration || isGif ? (
            <span className="absolute bottom-2 left-2 rounded bg-black/65 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-white">
              {duration ?? "GIF"}
            </span>
          ) : null}
        </>
      ) : (
        placeholder
      )}
    </button>
  );
}
