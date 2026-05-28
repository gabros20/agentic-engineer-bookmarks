"use client";

import { BarChart3, Film, Heart, MessageCircle, PlayCircle, Repeat2, Star } from "lucide-react";
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
      className="group mb-4 inline-block w-full min-w-0 cursor-pointer break-inside-avoid rounded-2xl border border-[#cfd9de] bg-white px-4 py-3 align-top shadow-sm transition hover:bg-[#f7f9f9]"
    >
      <div className="min-w-0">
        <div className="grid min-w-0 grid-cols-[40px_1fr] gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="h-10 w-10 rounded-full bg-[#eff3f4] object-cover"
            src={post.author.profileImageUrl ?? ""}
            alt=""
          />
          <div className="flex min-w-0 flex-wrap items-start gap-x-1 text-[14px] leading-5">
            <span className="truncate font-bold text-[#0f1419]">{post.author.name || "Unknown"}</span>
            <span className="truncate text-[#536471]">@{post.author.screenName || "unknown"}</span>
            <span className="text-[#536471]">·</span>
            <time className="text-[#536471]">{date}</time>
          </div>
        </div>

        <p className="mt-2 whitespace-pre-wrap break-words text-[14px] leading-5 text-[#0f1419]">{post.text}</p>

        {media.length > 0 ? <MediaGrid media={media} /> : null}

        {(post.articleTitle || (post.urls && post.urls.length > 0)) && (
          <div className="mt-3 flex flex-wrap gap-2">
          {post.articleTitle ? (
            <span className="max-w-full truncate rounded-full border border-[#cfd9de] bg-[#f7f9f9] px-2.5 py-1 text-xs text-[#536471]">
              {post.articleTitle}
            </span>
          ) : null}
          {(post.urls ?? []).slice(0, 2).map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="max-w-full truncate rounded-full border border-[#cfd9de] bg-white px-2.5 py-1 text-xs text-[#1d9bf0] hover:bg-[#eff3f4]"
            >
              {url}
            </a>
          ))}
          </div>
        )}

        <div className="mt-2 flex items-center justify-between text-[#536471]">
          <Metric icon={<MessageCircle size={16} />} value={metrics.replies} tone="reply" />
          <Metric icon={<Repeat2 size={16} />} value={metrics.retweets} tone="repost" />
          <Metric icon={<Heart size={16} />} value={metrics.likes} tone="like" />
          <Metric icon={<BarChart3 size={16} />} value={metrics.views} tone="view" />
          <button
            type="button"
            aria-pressed={isFavorite}
            onClick={() => onToggleFavorite(post.id)}
            className={[
              "inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-full px-1.5 text-xs transition",
              isFavorite ? "text-[#f91880] hover:bg-[#f91880]/10" : "text-[#536471] hover:bg-[#f91880]/10 hover:text-[#f91880]",
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

function Metric({
  icon,
  value,
  tone,
}: {
  icon: React.ReactNode;
  value?: number;
  tone: "reply" | "repost" | "like" | "view";
}) {
  const toneClass = {
    reply: "hover:bg-[#1d9bf0]/10 hover:text-[#1d9bf0]",
    repost: "hover:bg-[#00ba7c]/10 hover:text-[#00ba7c]",
    like: "hover:bg-[#f91880]/10 hover:text-[#f91880]",
    view: "hover:bg-[#1d9bf0]/10 hover:text-[#1d9bf0]",
  }[tone];

  return (
    <span className={`inline-flex h-8 items-center gap-1 rounded-full px-1.5 text-xs transition ${toneClass}`}>
      {icon}
      <span>{formatNumber(value)}</span>
    </span>
  );
}

function MediaGrid({ media }: { media: NonNullable<BookmarkPost["media"]> }) {
  const items = media.slice(0, 4);
  const count = items.length;
  const gridClass =
    count === 1
      ? "grid-cols-1"
      : count === 2
        ? "grid-cols-2"
        : "grid-cols-2";

  return (
    <div className={`mt-3 grid overflow-hidden rounded-2xl border border-[#cfd9de] bg-[#eff3f4] ${gridClass}`}>
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
    "min-h-0 w-full bg-[#eff3f4] object-cover",
    single ? "max-h-[360px] aspect-video" : "aspect-square border-[#cfd9de]",
    count > 1 && index % 2 === 1 ? "border-l" : "",
    count > 2 && index > 1 ? "border-t" : "",
    tallThird ? "row-span-2 h-full" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (isVideo) {
    return (
      <div
        className={`${className} flex items-center justify-center`}
        aria-label={item.type === "animated_gif" ? "Animated GIF on X" : "Video on X"}
      >
        <div className="grid justify-items-center gap-1.5 px-3 text-center text-[#536471]">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-[#0f1419]/85 text-white shadow-sm">
            <PlayCircle size={24} strokeWidth={2.2} />
          </div>
          <div className="flex items-center gap-1.5 text-xs font-bold text-[#0f1419]">
            <Film size={14} />
            {item.type === "animated_gif" ? "GIF on X" : "Video on X"}
          </div>
          <p className="max-w-36 text-[11px] leading-4">Open the post to watch.</p>
        </div>
      </div>
    );
  }

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
