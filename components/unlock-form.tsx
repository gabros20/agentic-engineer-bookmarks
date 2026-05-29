"use client";

import { KeyRound, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";

type Props = {
  open: boolean;
  onClose: () => void;
  onUnlocked: () => void;
};

export function UnlockForm({ open, onClose, onUnlocked }: Props) {
  const { t } = useLanguage();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setKey("");
      setError(null);
      setBusy(false);
      const t = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/digest/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key.trim() }),
      });
      if (response.status === 401) {
        setError(t("unlock.error.invalid"));
        setBusy(false);
        return;
      }
      if (!response.ok) {
        setError(t("unlock.error.generic", { code: response.status }));
        setBusy(false);
        return;
      }
      onUnlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setBusy(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-[color:var(--color-ink)]/40 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("unlock.title")}
        className="fixed left-1/2 top-1/2 z-50 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-5 shadow-[0_4px_20px_rgba(20,20,19,0.08)]"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 text-[color:var(--color-ink)]">
            <KeyRound size={18} className="text-[color:var(--color-primary)]" />
            <h2 className="font-display text-[22px] leading-tight">{t("unlock.title")}</h2>
          </div>
          <button
            type="button"
            aria-label={t("unlock.aria.close")}
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full text-[color:var(--color-muted)] transition hover:bg-[color:var(--color-surface-card)]"
          >
            <X size={18} />
          </button>
        </div>

        <p className="mt-2 text-[14px] leading-relaxed text-[color:var(--color-body)]">{t("unlock.hint")}</p>

        <form onSubmit={submit} className="mt-4 grid gap-3">
          <input
            ref={inputRef}
            type="password"
            autoComplete="current-password"
            inputMode="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={t("unlock.placeholder")}
            className="min-h-10 w-full rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-4 text-base text-[color:var(--color-ink)] outline-none transition placeholder:text-[color:var(--color-muted)] focus:border-[color:var(--color-primary)] focus:ring-[3px] focus:ring-[color:var(--color-primary)]/15"
            disabled={busy}
          />
          {error ? <p className="text-xs font-semibold text-[color:var(--color-error)]">{error}</p> : null}
          <button
            type="submit"
            disabled={!key.trim() || busy}
            className="flex min-h-10 items-center justify-center gap-2 rounded-md bg-[color:var(--color-primary)] px-5 text-sm font-medium text-[color:var(--color-on-primary)] transition hover:bg-[color:var(--color-primary-active)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {t("unlock.submit")}
          </button>
        </form>
      </div>
    </>
  );
}
