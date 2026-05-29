"use client";

import { Bookmark, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteDigest, listSavedDigests, type SavedDigest } from "@/lib/digest-cache";
import { useLanguage } from "@/lib/i18n";

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenDigest: (digest: SavedDigest) => void;
};

export function SavedDigestsPanel({ open, onClose, onOpenDigest }: Props) {
  const { t } = useLanguage();
  const [items, setItems] = useState<SavedDigest[]>([]);

  useEffect(() => {
    if (!open) return;
    setItems(listSavedDigests());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  function remove(query: string) {
    deleteDigest(query);
    setItems(listSavedDigests());
  }

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-[color:var(--color-ink)]/30 backdrop-blur-sm" onClick={onClose} />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] shadow-[0_0_30px_rgba(20,20,19,0.08)] sm:w-[28rem]"
        role="dialog"
        aria-label={t("saved.title")}
      >
        <header className="flex items-center justify-between gap-3 border-b border-[color:var(--color-hairline)] px-4 py-3">
          <div className="flex items-center gap-2 text-[color:var(--color-ink)]">
            <Bookmark size={18} className="text-[color:var(--color-primary)]" />
            <h2 className="font-display text-[22px] font-medium leading-tight">{t("saved.title")}</h2>
            <span className="rounded-full bg-[color:var(--color-surface-card)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-muted)]">{items.length}</span>
          </div>
          <button
            type="button"
            aria-label={t("saved.aria.close")}
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full text-[color:var(--color-muted)] transition hover:bg-[color:var(--color-surface-card)]"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-[color:var(--color-muted)]">{t("saved.empty")}</p>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => {
                const themeLabel = item.themes.length === 1 ? t("saved.themes", { n: 1 }) : t("saved.themesPlural", { n: item.themes.length });
                const sourceLabel = item.sourceCount === 1 ? t("digest.sources", { n: 1 }) : t("digest.sourcesPlural", { n: item.sourceCount });
                return (
                  <li key={item.query} className="group relative">
                    <button
                      type="button"
                      onClick={() => onOpenDigest(item)}
                      className="block w-full rounded-lg border border-[color:var(--color-hairline)] bg-[color:var(--color-surface-card)] p-3 text-left transition hover:border-[color:var(--color-primary)]/30 hover:bg-[color:var(--color-surface-cream-strong)]"
                    >
                      <div className="font-display text-[18px] font-medium leading-snug text-[color:var(--color-ink)] pr-9">{item.query}</div>
                      <div className="mt-1 text-[12px] text-[color:var(--color-muted)]">
                        {themeLabel} · {sourceLabel} · {formatAge(item.createdAt, t)}
                      </div>
                      {item.overall ? (
                        <p className="mt-1.5 line-clamp-2 text-[13px] leading-[1.55] text-[color:var(--color-body)]">{item.overall}</p>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      aria-label={t("saved.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(item.query);
                      }}
                      className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full text-[color:var(--color-muted)] opacity-0 transition hover:bg-[color:var(--color-error)]/10 hover:text-[color:var(--color-error)] group-hover:opacity-100"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
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
