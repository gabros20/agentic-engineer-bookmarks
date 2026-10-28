"use client";

import { MessagesSquare, Trash2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import {
  deleteChatById,
  fetchChat,
  fetchSavedChats,
  type SavedChat,
  type SavedChatMeta,
} from "@/lib/chat-history";
import { useLanguage } from "@/lib/i18n";
import { ResponsivePanel } from "@/components/ui/responsive-panel";

type Props = {
  onClose: () => void;
  onOpenChat: (chat: SavedChat) => void;
};

export function SavedChatsPanel({ onClose, onOpenChat }: Props) {
  const { t } = useLanguage();
  const [items, setItems] = useState<SavedChatMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  // Transient action error — a reopen that failed to load (T6 M2) or a delete that failed
  // server-side (T6 M3). Shown as a small inline banner without replacing the list.
  const [actionError, setActionError] = useState<null | "reopen" | "delete">(null);

  // DB-backed (T6): fetch the user's saved chats (metadata) on open — cross-device.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    fetchSavedChats()
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


  function remove(id: string) {
    // Optimistic delete with rollback (T6 M3): on failure restore the row + surface an error so
    // the UI never silently diverges from the DB (the item would reappear on the next load).
    const snapshot = items;
    setActionError(null);
    setItems((current) => current.filter((c) => c.id !== id));
    deleteChatById(id).catch(() => {
      setItems(snapshot);
      setActionError("delete");
    });
  }

  // Load the full conversation (its ordered messages) before opening — the list carries
  // metadata only. A single in-flight open at a time. On a failed load (T6 M2) surface an error
  // instead of silently doing nothing.
  async function open(id: string) {
    if (openingId) return;
    setOpeningId(id);
    setActionError(null);
    try {
      const chat = await fetchChat(id);
      if (chat) onOpenChat(chat);
      else setActionError("reopen");
    } catch {
      setActionError("reopen");
    } finally {
      setOpeningId(null);
    }
  }

  return (
    <ResponsivePanel title={t("chat.title")} onClose={onClose} className="h-[80dvh] sm:h-[min(40rem,85vh)] sm:max-w-lg">
      {(close) => (
        <>
            <header className="flex items-center justify-between gap-3 border-b border-[color:var(--color-hairline)] px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-2 text-[color:var(--color-ink)]">
                <MessagesSquare size={18} className="shrink-0 text-[color:var(--color-primary)]" />
                <h2 className="truncate font-display text-[22px] leading-tight">{t("chat.title")}</h2>
                <span className="shrink-0 rounded-sm bg-[color:var(--color-surface-card)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[1.5px] text-[color:var(--color-muted)]">
                  {items.length}
                </span>
              </div>
              <button
                type="button"
                aria-label={t("chat.aria.close")}
                onClick={close}
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
                  {t(actionError === "reopen" ? "chat.reopenError" : "chat.deleteError")}
                </p>
              ) : null}
              {loading ? (
                <p className="py-8 text-center text-sm text-[color:var(--color-muted)]">
                  {t("chat.loading")}
                </p>
              ) : error ? (
                <p className="py-8 text-center text-sm text-[color:var(--color-error)]">
                  {t("chat.error")}
                </p>
              ) : items.length === 0 ? (
                <p className="py-8 text-center text-sm text-[color:var(--color-muted)]">
                  {t("chat.empty")}
                </p>
              ) : (
                <ul className="space-y-2">
                  <AnimatePresence initial={true}>
                    {items.map((item, i) => (
                      <motion.li
                        key={item.id}
                        layout
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: 24, transition: { duration: 0.18 } }}
                        transition={{ type: "spring", stiffness: 380, damping: 32, delay: i * 0.03 }}
                        className="group relative"
                      >
                        <button
                          type="button"
                          onClick={() => open(item.id)}
                          disabled={openingId === item.id}
                          className="block w-full rounded-lg border border-[color:var(--color-hairline)] bg-[color:var(--color-surface-card)] p-3 text-left transition hover:border-[color:var(--color-primary)]/30 hover:bg-[color:var(--color-surface-cream-strong)] disabled:opacity-60"
                        >
                          <div className="font-display text-[18px] leading-snug text-[color:var(--color-ink)] pr-9">
                            {item.title}
                          </div>
                          <div className="mt-1 text-[12px] text-[color:var(--color-muted)]">
                            {item.language.toUpperCase()} · {formatAge(item.createdAt, t)}
                            {item.query ? ` · ${item.query}` : ""}
                          </div>
                        </button>
                        <button
                          type="button"
                          aria-label="Delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            remove(item.id);
                          }}
                          className="absolute right-2 top-2 grid h-9 w-9 place-items-center rounded-full text-[color:var(--color-muted)] opacity-100 transition hover:bg-[color:var(--color-error)]/10 hover:text-[color:var(--color-error)] sm:h-7 sm:w-7 sm:opacity-0 sm:group-hover:opacity-100"
                        >
                          <Trash2 size={14} />
                        </button>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )}
            </div>
        </>
      )}
    </ResponsivePanel>
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
