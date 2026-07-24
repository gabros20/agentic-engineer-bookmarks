"use client";

import { ArrowLeft, KeyRound, Loader2, Mail, MailCheck } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { LanguageSwitcher } from "@/components/language-switcher";
import { authClient } from "@/lib/auth-client";
import { useLanguage } from "@/lib/i18n";

type Stage = "form" | "sent";

export function LoginForm() {
  const { t } = useLanguage();
  const [stage, setStage] = useState<Stage>("form");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  // T3 a11y/UX: focus the first field on mount so keyboard users can type immediately.
  useEffect(() => {
    codeRef.current?.focus();
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!code.trim() || !email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Step 1: reserve the invite. The endpoint returns bilingual `error`
      // strings ("EN / HU"), so surface them directly on failure.
      const res = await fetch("/api/invite/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim(), email: email.trim() }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? t("login.error.generic"));
        setBusy(false);
        return;
      }

      // Step 2: send the magic link. Account creation is still gated server-side
      // by the reservation we just made (lib/auth databaseHooks).
      const { error: linkError } = await authClient.signIn.magicLink({
        email: email.trim(),
        callbackURL: "/",
      });
      if (linkError) {
        setError(t("login.error.link"));
        setBusy(false);
        return;
      }
      setStage("sent");
      setBusy(false);
    } catch {
      // T3: surface a LOCALIZED (EN/HU) message, never a raw fetch/exception string.
      setError(t("login.error.generic"));
      setBusy(false);
    }
  }

  function backToForm() {
    setStage("form");
    setError(null);
    window.setTimeout(() => codeRef.current?.focus(), 60);
  }

  return (
    <main className="relative flex min-h-[100svh] items-center justify-center bg-[color:var(--color-canvas)] px-4 py-10">
      <div className="absolute right-4 top-4">
        <LanguageSwitcher />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 460, damping: 32 }}
        className="w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] p-6 shadow-[0_4px_20px_rgba(20,20,19,0.08)]"
      >
        {stage === "form" ? (
          <>
            <div className="flex items-center gap-2 text-[color:var(--color-ink)]">
              <KeyRound size={18} className="text-[color:var(--color-primary)]" />
              <h1 className="font-display text-[26px] leading-tight">{t("login.title")}</h1>
            </div>
            <p className="mt-2 text-[14px] leading-relaxed text-[color:var(--color-body)]">
              {t("login.hint")}
            </p>

            <form onSubmit={submit} className="mt-5 grid gap-3">
              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                  {t("login.code.label")}
                </span>
                <input
                  ref={codeRef}
                  type="text"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t("login.code.placeholder")}
                  className="min-h-10 w-full rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-4 text-base text-[color:var(--color-ink)] outline-none transition placeholder:text-[color:var(--color-muted)] focus:border-[color:var(--color-primary)] focus:ring-[3px] focus:ring-[color:var(--color-primary)]/15"
                  disabled={busy}
                />
              </label>

              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                  {t("login.email.label")}
                </span>
                <input
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t("login.email.placeholder")}
                  className="min-h-10 w-full rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-4 text-base text-[color:var(--color-ink)] outline-none transition placeholder:text-[color:var(--color-muted)] focus:border-[color:var(--color-primary)] focus:ring-[3px] focus:ring-[color:var(--color-primary)]/15"
                  disabled={busy}
                />
              </label>

              {error ? (
                <p
                  role="alert"
                  aria-live="polite"
                  className="text-xs font-semibold text-[color:var(--color-error)]"
                >
                  {error}
                </p>
              ) : null}

              <motion.button
                type="submit"
                disabled={!code.trim() || !email.trim() || busy}
                whileTap={{ scale: 0.97 }}
                transition={{ type: "spring", stiffness: 500, damping: 30 }}
                className="mt-1 flex min-h-10 items-center justify-center gap-2 rounded-md bg-[color:var(--color-primary)] px-5 text-sm font-medium text-[color:var(--color-on-primary)] transition-colors hover:bg-[color:var(--color-primary-active)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                {t("login.submit")}
              </motion.button>
            </form>
          </>
        ) : (
          <div className="text-center">
            <div className="mx-auto grid size-12 place-items-center rounded-full bg-[color:var(--color-surface-cream-strong)]">
              <MailCheck size={22} className="text-[color:var(--color-primary)]" />
            </div>
            <h1 className="mt-4 font-display text-[26px] leading-tight text-[color:var(--color-ink)]">
              {t("login.sent.title")}
            </h1>
            <p className="mt-2 text-[14px] leading-relaxed text-[color:var(--color-body)]">
              {t("login.sent.body", { email: email.trim() })}
            </p>
            <button
              type="button"
              onClick={backToForm}
              className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-[color:var(--color-primary)] transition hover:text-[color:var(--color-primary-active)]"
            >
              <ArrowLeft size={14} />
              {t("login.sent.back")}
            </button>
          </div>
        )}
      </motion.div>
    </main>
  );
}
