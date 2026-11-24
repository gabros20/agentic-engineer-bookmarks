"use client";

import { useLanguage, type Lang } from "@/lib/i18n";
import { useSyncStatus } from "@/lib/queries";
import { cn } from "@/lib/utils";

// "Synced 2 hours ago" at the foot of the header menu, from the heartbeat the Mac's sync writes on
// every success. Past STALE_DAYS it turns into a warning (and the menu button gets an amber dot), so a
// sync that silently stopped is visible from the site itself — the autopilot's own "no sync for 3
// days" notification can't fire when the agent isn't running at all.

const STALE_DAYS = 3; // same threshold as the autopilot's staleDays alert
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type SyncHealth = { ageMs: number; stale: boolean };

/** When the bookmarks last synced (falls back to the live data's publish time before the first heartbeat). */
export function useSyncHealth(): SyncHealth | null {
  const { data } = useSyncStatus();
  const time = Date.parse(data?.syncedAt ?? data?.publishedAt ?? "");
  if (!Number.isFinite(time)) return null;
  const ageMs = Math.max(0, Date.now() - time);
  return { ageMs, stale: ageMs > STALE_DAYS * DAY };
}

function relative(ageMs: number, lang: Lang) {
  const format = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (ageMs < HOUR) return format.format(-Math.round(ageMs / MINUTE), "minute");
  if (ageMs < DAY) return format.format(-Math.round(ageMs / HOUR), "hour");
  return format.format(-Math.round(ageMs / DAY), "day");
}

export function SyncStatusLine({ health }: { health: SyncHealth | null }) {
  const { t, lang } = useLanguage();
  if (!health) return null;
  return (
    <div role="status" className="px-2 py-1.5 text-xs leading-snug">
      <div className={cn("flex items-center gap-2", health.stale ? "font-medium text-[color:var(--color-ink)]" : "text-[color:var(--color-muted)]")}>
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", health.stale ? "bg-[color:var(--color-accent-amber)]" : "bg-[color:var(--color-success)]")} />
        {t("sync.synced", { ago: relative(health.ageMs, lang) })}
      </div>
      {health.stale ? <p className="mt-1 pl-3.5 text-[color:var(--color-muted)]">{t("sync.staleHint")}</p> : null}
    </div>
  );
}
