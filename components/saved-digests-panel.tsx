"use client";

import { Bookmark, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { RemoveScroll } from "react-remove-scroll";
import { useEffect, useState } from "react";
import { deleteDigestById, fetchSavedDigests, type SavedDigest } from "@/lib/digest-cache";
import { useLanguage } from "@/lib/i18n";

type Props = {
  onClose: () => void;
  onOpenDigest: (digest: SavedDigest) => void;
};

export function SavedDigestsPanel({ onClose, onOpenDigest }: Props) {
  const { t } = useLanguage();
  const [items, setItems] = useState<SavedDigest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // Transient action error (e.g. a delete that failed server-side) — distinct from the
  // list-load `error` above, shown as a small inline banner without replacing the list.
  const [actionError, setActionError] = useState(false);

  // DB-backed (T6): fetch the user's saved digests on open — the source of truth is the DB, so
  // these appear on every device, not just where they were generated.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    fetchSavedDigests()
      .then((rows) => {
        if (alive) setItems(rows);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function remove(id: string) {
    // Optimistic: drop it from the list immediately, then delete server-side (user-scoped). On
    // failure (T6 M3) restore the row and show a small error, so the UI never silently diverges
    // from the DB (the item would otherwise reappear on the next load).
    const snapshot = items;
    setActionError(false);
    setItems((current) => current.filter((d) => d.id !== id));
    deleteDigestById(id).catch(() => {
      setItems(snapshot);
      setActionError(true);
    });
  }

  return (
    <RemoveScroll>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-40 bg-[color:var(--color-ink)]/30 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", stiffness: 360, damping: 40, mass: 0.8 }}
        style={{ paddingTop: "env(safe-area-inset-top)" }}
        className="fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] shadow-[0_0_30px_rgba(20,20,19,0.08)] sm:w-[28rem]"
        role="dialog"
        aria-label={t("saved.title")}
      >
        <div className="sm:hidden flex justify-center pt-2">
          <span className="h-1 w-9 rounded-full bg-[color:var(--color-hairline)]" aria-hidden />
        </div>

        <header className="flex items-center justify-between gap-3 border-b border-[color:var(--color-hairline)] px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2 text-[color:var(--color-ink)]">
            <Bookmark size={18} className="shrink-0 text-[color:var(--color-primary)]" />
            <h2 className="truncate font-display text-[22px] leading-tight">{t("saved.title")}</h2>
            <span className="shrink-0 rounded-sm bg-[color:var(--color-surface-card)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-muted)]">{items.length}</span>
          </div>
          <button
            type="button"
            aria-label={t("saved.aria.close")}
            onClick={onClose}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[color:var(--color-muted)] transition hover:bg-[color:var(--color-surface-card)] sm:h-8 sm:w-8"
          >
            <X size={20} className="sm:hidden" />
            <X size={18} className="hidden sm:block" />
          </button>
        </header>

        <div
          className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
        >
          {actionError ? (
            <p className="mb-3 rounded-lg border border-[color:var(--color-error)]/30 bg-[color:var(--color-error)]/5 p-2.5 text-center text-[13px] text-[color:var(--color-error)]" role="alert">
              {t("saved.deleteError")}
            </p>
          ) : null}
          {loading ? (
            <p className="py-8 text-center text-sm text-[color:var(--color-muted)]">{t("saved.loading")}</p>
          ) : error ? (
            <p className="py-8 text-center text-sm text-[color:var(--color-error)]">{t("saved.error")}</p>
          ) : items.length === 0 ? (
            <p className="py-8 text-center text-sm text-[color:var(--color-muted)]">{t("saved.empty")}</p>
          ) : (
            <ul className="space-y-2">
              <AnimatePresence initial={true}>
                {items.map((item, i) => {
                  const themeLabel = item.themes.length === 1 ? t("saved.themes", { n: 1 }) : t("saved.themesPlural", { n: item.themes.length });
                  const sourceLabel = item.sourceCount === 1 ? t("digest.sources", { n: 1 }) : t("digest.sourcesPlural", { n: item.sourceCount });
                  // `tldr` is absent on OLD saved entries (pre-T2, themes+overall only) — fall
                  // back to `overall`, which every saved entry has always had.
                  const preview = item.tldr || item.overall;
                  return (
                    <motion.li
                      key={item.id ?? item.query}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }}
                      transition={{ type: "spring", stiffness: 380, damping: 32, delay: i * 0.03 }}
                      className="group relative"
                    >
                      <button
                        type="button"
                        onClick={() => onOpenDigest(item)}
                        className="block w-full rounded-lg border border-[color:var(--color-hairline)] bg-[color:var(--color-surface-card)] p-3 text-left transition hover:border-[color:var(--color-primary)]/30 hover:bg-[color:var(--color-surface-cream-strong)]"
                      >
                        <div className="font-display text-[18px] leading-snug text-[color:var(--color-ink)] pr-9">{item.query}</div>
                        <div className="mt-1 text-[12px] text-[color:var(--color-muted)]">
                          {themeLabel} · {sourceLabel} · {formatAge(item.createdAt, t)}
                        </div>
                        {preview ? (
                          <p className="mt-1.5 line-clamp-2 text-[13px] leading-[1.55] text-[color:var(--color-body)]">{preview}</p>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        aria-label={t("saved.delete")}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (item.id) remove(item.id);
                        }}
                        className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full text-[color:var(--color-muted)] opacity-100 transition hover:bg-[color:var(--color-error)]/10 hover:text-[color:var(--color-error)] sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100"
                      >
                        <Trash2 size={14} />
                      </button>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
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
