"use client";

import { Laptop } from "lucide-react";
import { motion } from "motion/react";

import { LanguageSwitcher } from "@/components/language-switcher";
import { useLanguage } from "@/lib/i18n";

/** Phones and tablets (iPadOS reports a Mac UA, but has touch points). */
export function isHandheld(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/**
 * RFC 8252 loopback redirect (http://localhost:<port>/…): the app — Claude Code, Cursor, … —
 * receives the sign-in result on a listener that exists only on the computer that started it.
 */
export function isLoopbackRedirect(uri: string | null | undefined): boolean {
  if (!uri) return false;
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Shown on a phone/tablet when the app being connected waits on a computer: continuing here
 * would send the PHONE to its own localhost ("Safari can't open the page"). Explains how to
 * finish on the computer instead (the sign-in page there takes the 6-digit code from the email).
 */
export function OtherDeviceNotice({ clientName, onOverride }: { clientName?: string | null; onOverride: () => void }) {
  const { t } = useLanguage();
  const name = clientName || t("consent.unknownClient");
  return (
    <main className="relative flex min-h-[100svh] items-center justify-center bg-[color:var(--color-canvas)] px-4 py-10">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 460, damping: 32 }}
        className="w-[min(26rem,calc(100vw-2rem))] rounded-xl border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-6 shadow-[0_4px_20px_rgba(20,20,19,0.08)]"
      >
        <div className="flex items-center gap-2 text-[color:var(--color-ink)]">
          <Laptop size={18} className="text-[color:var(--color-primary)]" />
          <h1 className="font-display text-[26px] leading-tight">{t("consent.otherDevice.title")}</h1>
        </div>
        <p className="mt-3 text-[15px] leading-relaxed text-[color:var(--color-ink)]">{t("consent.otherDevice.body", { client: name })}</p>
        <ol className="mt-4 grid list-decimal gap-1.5 pl-5 text-[14px] leading-relaxed text-[color:var(--color-body)]">
          <li>{t("consent.otherDevice.step1")}</li>
          <li>{t("consent.otherDevice.step2")}</li>
        </ol>
        <p className="mt-4 text-xs leading-relaxed text-[color:var(--color-muted)]">{t("consent.otherDevice.note")}</p>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <a
            href="/"
            className="inline-flex min-h-10 items-center rounded-md bg-[color:var(--color-primary)] px-4 text-sm font-medium text-[color:var(--color-on-primary)] transition-colors hover:bg-[color:var(--color-primary-active)]"
          >
            {t("consent.otherDevice.open")}
          </a>
          <button
            type="button"
            onClick={onOverride}
            className="text-xs font-medium text-[color:var(--color-muted)] underline-offset-2 hover:underline"
          >
            {t("consent.otherDevice.override")}
          </button>
        </div>
      </motion.div>
    </main>
  );
}
