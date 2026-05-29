"use client";

import { Bookmark, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { deleteDigest, listSavedDigests, type SavedDigest } from "@/lib/digest-cache";

type Props = {
  open: boolean;
  onClose: () => void;
  onOpenDigest: (digest: SavedDigest) => void;
};

export function SavedDigestsPanel({ open, onClose, onOpenDigest }: Props) {
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
      <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col bg-white shadow-2xl ring-1 ring-[#eff3f4] sm:w-[28rem]"
        role="dialog"
        aria-label="Saved digests"
      >
        <header className="flex items-center justify-between gap-3 border-b border-[#eff3f4] px-4 py-3">
          <div className="flex items-center gap-2 text-[#0f1419]">
            <Bookmark size={18} className="text-[#1d9bf0]" />
            <h2 className="text-base font-extrabold">Saved digests</h2>
            <span className="rounded-full bg-[#eff3f4] px-2 py-0.5 text-[10px] font-bold text-[#536471]">{items.length}</span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-full text-[#536471] transition hover:bg-[#eff3f4]"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {items.length === 0 ? (
            <p className="py-8 text-center text-sm text-[#536471]">
              No saved digests yet. Run an AI Digest from any search and it will be saved here for next time.
            </p>
          ) : (
            <ul className="space-y-2">
              {items.map((item) => (
                <li key={item.query} className="group relative">
                  <button
                    type="button"
                    onClick={() => onOpenDigest(item)}
                    className="block w-full rounded-2xl border border-[#eff3f4] bg-white p-3 text-left transition hover:border-[#cfd9de] hover:bg-[#f7f9f9]"
                  >
                    <div className="text-sm font-extrabold text-[#0f1419] pr-9">{item.query}</div>
                    <div className="mt-0.5 text-[12px] text-[#536471]">
                      {item.themes.length} theme{item.themes.length === 1 ? "" : "s"} · {item.sourceCount} source{item.sourceCount === 1 ? "" : "s"} · {formatAge(item.createdAt)}
                    </div>
                    {item.overall ? (
                      <p className="mt-1.5 line-clamp-2 text-[12px] leading-4 text-[#536471]">{item.overall}</p>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    aria-label="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(item.query);
                    }}
                    className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full text-[#536471] opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

function formatAge(iso: string) {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}
