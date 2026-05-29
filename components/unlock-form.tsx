"use client";

import { KeyRound, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  onUnlocked: () => void;
};

export function UnlockForm({ open, onClose, onUnlocked }: Props) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setKey("");
      setError(null);
      setBusy(false);
      // Give the dialog a tick to mount before focusing.
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
        setError("Invalid passkey.");
        setBusy(false);
        return;
      }
      if (!response.ok) {
        setError(`Unlock failed (${response.status}).`);
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
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Enter passkey"
        className="fixed left-1/2 top-1/2 z-50 w-[min(22rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-3xl bg-white p-5 shadow-2xl ring-1 ring-[#eff3f4]"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 text-[#0f1419]">
            <KeyRound size={18} className="text-[#1d9bf0]" />
            <h2 className="text-base font-extrabold">Unlock AI Digest</h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full text-[#536471] transition hover:bg-[#eff3f4]"
          >
            <X size={18} />
          </button>
        </div>

        <p className="mt-2 text-[13px] text-[#536471]">
          Enter the passkey to enable AI digests on this device. Saved for one year.
        </p>

        <form onSubmit={submit} className="mt-4 grid gap-3">
          <input
            ref={inputRef}
            type="password"
            autoComplete="current-password"
            inputMode="text"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Passkey"
            className="min-h-11 w-full rounded-full border border-[#cfd9de] bg-[#f7f9f9] px-4 text-base text-[#0f1419] outline-none transition placeholder:text-[#536471] focus:border-[#1d9bf0] focus:bg-white focus:ring-2 focus:ring-[#1d9bf0]"
            disabled={busy}
          />
          {error ? <p className="text-xs font-bold text-red-600">{error}</p> : null}
          <button
            type="submit"
            disabled={!key.trim() || busy}
            className="flex min-h-11 items-center justify-center gap-2 rounded-full bg-[#1d9bf0] px-4 text-sm font-bold text-white transition hover:bg-[#1a8cd8] disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            Unlock
          </button>
        </form>
      </div>
    </>
  );
}
