"use client";

import { ExternalLink, Star } from "lucide-react";
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

  return (
    <article
      role="link"
      tabIndex={0}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("a,button")) return;
        openPost(post);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") openPost(post);
      }}
      className={[
        "group grid min-w-0 cursor-pointer gap-4 rounded-lg border bg-[#fffdf8] p-4 shadow-[0_18px_50px_rgba(33,29,25,0.08)] transition",
        isFavorite
          ? "border-[#b98318] ring-4 ring-[#b98318]/20"
          : "border-[#211d19] hover:-translate-y-0.5 hover:shadow-[0_22px_60px_rgba(33,29,25,0.12)]",
      ].join(" ")}
    >
      <div className="grid min-w-0 grid-cols-[48px_1fr_auto] items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="h-12 w-12 rounded-full border border-[#211d19] bg-[#e4ded3] object-cover"
          src={post.author.profileImageUrl ?? ""}
          alt=""
        />
        <div className="min-w-0">
          <div className="truncate font-extrabold">{post.author.name || "Unknown"}</div>
          <div className="text-sm text-[#746b61]">@{post.author.screenName || "unknown"}</div>
        </div>
        <time className="text-right text-xs text-[#746b61]">{date}</time>
      </div>

      <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-[#211d19]">{post.text}</p>

      {(post.articleTitle || (post.urls && post.urls.length > 0)) && (
        <div className="flex flex-wrap gap-2">
          {post.articleTitle ? (
            <span className="max-w-full truncate rounded-full border border-[#d7cbbd] bg-[#f3ede2] px-2.5 py-1 text-xs text-[#176c65]">
              {post.articleTitle}
            </span>
          ) : null}
          {(post.urls ?? []).map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noreferrer"
              className="max-w-full truncate rounded-full border border-[#d7cbbd] bg-[#f3ede2] px-2.5 py-1 text-xs text-[#176c65] underline-offset-2 hover:underline"
            >
              {url}
            </a>
          ))}
        </div>
      )}

      <div className="grid grid-cols-4 gap-2 border-t border-[#d7cbbd] pt-3 text-xs text-[#746b61]">
        <span>
          <b className="block text-[15px] text-[#211d19]">{formatNumber(metrics.bookmarks)}</b>
          saves
        </span>
        <span>
          <b className="block text-[15px] text-[#211d19]">{formatNumber(metrics.likes)}</b>
          likes
        </span>
        <span>
          <b className="block text-[15px] text-[#211d19]">{formatNumber(metrics.retweets)}</b>
          reposts
        </span>
        <span>
          <b className="block text-[15px] text-[#211d19]">{formatNumber(metrics.views)}</b>
          views
        </span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <a
          href={postUrl(post)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-9 items-center gap-2 rounded border border-[#211d19] px-3 text-sm font-extrabold transition hover:bg-[#211d19] hover:text-[#fffdf8]"
        >
          Open
          <ExternalLink size={15} strokeWidth={2.4} />
        </a>
        <button
          type="button"
          aria-pressed={isFavorite}
          onClick={() => onToggleFavorite(post.id)}
          className={[
            "inline-flex min-h-9 items-center gap-2 rounded border px-3 text-sm font-extrabold transition",
            isFavorite
              ? "border-[#b98318] bg-[#fff3cf] text-[#6f4600]"
              : "border-[#211d19] bg-[#fffdf8] text-[#211d19] hover:bg-[#211d19] hover:text-[#fffdf8]",
          ].join(" ")}
        >
          <Star size={16} strokeWidth={2.4} fill={isFavorite ? "currentColor" : "none"} />
          {isFavorite ? "Starred" : "Star"}
        </button>
      </div>
    </article>
  );
}
