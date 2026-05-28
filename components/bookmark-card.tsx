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
      className="group grid min-w-0 cursor-pointer grid-cols-[44px_1fr] gap-3 border-b border-[#eff3f4] bg-white px-4 py-3 transition hover:bg-[#f7f9f9]"
    >
      <div className="pt-1">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="h-11 w-11 rounded-full bg-[#eff3f4] object-cover"
          src={post.author.profileImageUrl ?? ""}
          alt=""
        />
      </div>

      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-1 text-[15px] leading-5">
          <span className="truncate font-bold text-[#0f1419]">{post.author.name || "Unknown"}</span>
          <span className="truncate text-[#536471]">@{post.author.screenName || "unknown"}</span>
          <span className="text-[#536471]">·</span>
          <time className="text-[#536471]">{date}</time>
        </div>

        <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-5 text-[#0f1419]">{post.text}</p>

        {media.length > 0 ? <MediaGrid media={media} /> : null}

        {(post.articleTitle || (post.urls && post.urls.length > 0)) && (
          <div className="mt-3 flex flex-wrap gap-2">
          {post.articleTitle ? (
            <span className="max-w-full truncate rounded-full border border-[#cfd9de] bg-[#f7f9f9] px-3 py-1 text-sm text-[#536471]">
              {post.articleTitle}
            </span>
          ) : null}
          {(post.urls ?? []).map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="max-w-full truncate rounded-full border border-[#cfd9de] bg-white px-3 py-1 text-sm text-[#1d9bf0] hover:bg-[#eff3f4]"
            >
              {url}
            </a>
          ))}
          </div>
        )}

        <div className="mt-3 flex max-w-md items-center justify-between text-[#536471]">
          <Metric icon={<MessageCircle size={18} />} value={metrics.replies} tone="reply" />
          <Metric icon={<Repeat2 size={18} />} value={metrics.retweets} tone="repost" />
          <Metric icon={<Heart size={18} />} value={metrics.likes} tone="like" />
          <Metric icon={<BarChart3 size={18} />} value={metrics.views} tone="view" />
          <button
            type="button"
            aria-pressed={isFavorite}
            onClick={() => onToggleFavorite(post.id)}
            className={[
              "inline-flex h-9 min-w-9 items-center justify-center gap-1 rounded-full px-2 text-sm transition",
              isFavorite ? "text-[#f91880] hover:bg-[#f91880]/10" : "text-[#536471] hover:bg-[#f91880]/10 hover:text-[#f91880]",
            ].join(" ")}
            title={isFavorite ? "Remove star" : "Star"}
          >
            <Star size={18} strokeWidth={2.2} fill={isFavorite ? "currentColor" : "none"} />
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
    <span className={`inline-flex h-9 items-center gap-1 rounded-full px-2 text-sm transition ${toneClass}`}>
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
    single ? "max-h-[520px] aspect-video" : "aspect-square border-[#cfd9de]",
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
        <div className="grid justify-items-center gap-2 px-4 text-center text-[#536471]">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-[#0f1419]/85 text-white shadow-sm">
            <PlayCircle size={30} strokeWidth={2.2} />
          </div>
          <div className="flex items-center gap-1.5 text-sm font-bold text-[#0f1419]">
            <Film size={16} />
            {item.type === "animated_gif" ? "GIF on X" : "Video on X"}
          </div>
          <p className="max-w-48 text-xs leading-4">Open the original post to watch this media.</p>
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
