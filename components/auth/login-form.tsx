"use client";

import { ArrowLeft, Check, KeyRound, Loader2, Mail, MailCheck } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { LanguageSwitcher } from "@/components/shell/language-switcher";
import { authClient } from "@/lib/auth-client";
import { useLanguage } from "@/lib/i18n";

type Stage = "form" | "sent";

// Params Better Auth's OAuth provider adds when it bounces an MCP client's authorize request to
// this login page (the signature over the query + its expiry/bookkeeping).
const OAUTH_SIGNATURE_PARAMS = ["sig", "exp", "ba_iat", "ba_param", "ba_pl"];

/**
 * MCP OAuth (lib/auth.ts `mcp({ loginPage: "/login" })`): when an MCP client's
 * /oauth2/authorize request arrives without a session, Better Auth redirects here with the
 * original authorize query (+ a signature). Better Auth's built-in resume hooks the SIGN-IN
 * request, but a magic link signs in later, from the email — so instead we make the link land
 * back on the authorize endpoint itself: callbackURL = the original authorize request. With the
 * fresh session cookie it continues to /consent and on to the client. `prompt=login` is dropped
 * because the magic-link sign-in that precedes it satisfies it. Returns null for a normal login.
 * Replaying the request needs no trust in these params: authorize re-validates the client and its
 * redirect_uri, and nothing is granted without the /consent screen.
 */
function oauthResumeCallback(search: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.get("client_id") || !params.get("response_type")) return null;
  for (const key of OAUTH_SIGNATURE_PARAMS) params.delete(key);
  const prompt = (params.get("prompt") ?? "").split(" ").filter((p) => p && p !== "login");
  if (prompt.length) params.set("prompt", prompt.join(" "));
  else params.delete("prompt");
  return `/api/auth/oauth2/authorize?${params.toString()}`;
}

/**
 * base64url of a same-origin path: survives the magic link's callbackURL being decoded on the
 * way through Better Auth's verify redirect (a nested `?…&…` query would be split apart).
 * Decoded by components/continue-authorize.tsx.
 */
function encodeTarget(path: string): string {
  return btoa(path).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function LoginForm() {
  const { t } = useLanguage();
  const [stage, setStage] = useState<Stage>("form");
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const otpRef = useRef<HTMLInputElement>(null);
  // The 6-digit code from the email, typed here when the email was opened on another device.
  const [otp, setOtp] = useState("");
  const [otpError, setOtpError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  // Set on mount (window is client-only): the authorize request to resume after the magic link.
  const [oauthCallback, setOauthCallback] = useState<string | null>(null);

  // T3 a11y/UX: focus the first field on mount so keyboard users can type immediately. The invite
  // code is only needed once, so returning users start at the email.
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    emailRef.current?.focus();
    setOauthCallback(oauthResumeCallback(window.location.search));
  }, []);

  useEffect(() => {
    if (stage === "sent") window.setTimeout(() => otpRef.current?.focus(), 80);
  }, [stage]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!email.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Step 1 (first sign-in only): reserve the invite. The endpoint returns bilingual
      // `error` strings ("EN / HU"), so surface them directly on failure. Returning users skip
      // it — the server only emails known accounts or valid reservations either way.
      if (code.trim()) {
        const res = await fetch("/api/invite/verify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: code.trim(), email: email.trim() }),
        });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !data?.ok) {
          setError(data?.error ?? t("login.error.generic"));
          setBusy(false);
          return;
        }
      }

      // Step 2: one email with the magic link AND a 6-digit code (app/api/login/send). Account
      // creation is still gated server-side by the reservation (lib/auth databaseHooks).
      const res = await fetch("/api/login/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // An app connection's LINK goes through /login/continue, which stops a phone from being
        // sent to the computer's localhost; the code (below) resumes the authorize request directly.
        body: JSON.stringify({
          email: email.trim(),
          callbackURL: oauthCallback ? `/login/continue?to=${encodeTarget(oauthCallback)}` : "/",
        }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? t("login.error.link"));
        setBusy(false);
        return;
      }
      setOtp("");
      setOtpError(null);
      setStage("sent");
      setBusy(false);
    } catch {
      // T3: surface a LOCALIZED (EN/HU) message, never a raw fetch/exception string.
      setError(t("login.error.generic"));
      setBusy(false);
    }
  }

  // Finish with the code from the email — on THIS device, wherever the email was opened.
  async function verifyCode(event: React.FormEvent) {
    event.preventDefault();
    const value = otp.replace(/\D/g, "");
    if (value.length !== 6 || verifying) return;
    setVerifying(true);
    setOtpError(null);
    try {
      const { error: otpErr } = await authClient.signIn.emailOtp({ email: email.trim(), otp: value });
      if (otpErr) {
        setOtpError(t("login.otp.error"));
        setVerifying(false);
        return;
      }
      // Signed in here: resume the MCP authorize request (→ consent → the app on this computer),
      // or open the app.
      window.location.assign(oauthCallback ?? "/");
    } catch {
      setOtpError(t("login.otp.error"));
      setVerifying(false);
    }
  }

  function backToForm() {
    setStage("form");
    setError(null);
    window.setTimeout(() => emailRef.current?.focus(), 60);
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
            {oauthCallback ? (
              <p className="mt-2 rounded-md bg-[color:var(--color-surface-cream-strong)] px-3 py-2 text-[13px] leading-relaxed text-[color:var(--color-body)]">
                {t("login.oauth.hint")}
              </p>
            ) : null}

            <form onSubmit={submit} className="mt-5 grid gap-3">
              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                  {t("login.email.label")}
                </span>
                <input
                  ref={emailRef}
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

              <label className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                  {t("login.code.label")}{" "}
                  <span className="font-normal normal-case tracking-normal">{t("login.code.optional")}</span>
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
                disabled={!email.trim() || busy}
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
            {oauthCallback ? (
              <p className="mt-3 rounded-md bg-[color:var(--color-surface-cream-strong)] px-3 py-2 text-left text-[13px] leading-relaxed text-[color:var(--color-body)]">
                {t("login.sent.oauth")}
              </p>
            ) : null}

            <form onSubmit={verifyCode} className="mt-5 grid gap-2 text-left">
              <label htmlFor="login-otp" className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                {t("login.otp.label")}
              </label>
              <div className="flex gap-2">
                <input
                  id="login-otp"
                  ref={otpRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9 ]*"
                  maxLength={7}
                  value={otp}
                  onChange={(e) => {
                    setOtp(e.target.value.replace(/[^0-9]/g, "").slice(0, 6));
                    setOtpError(null);
                  }}
                  placeholder="123456"
                  aria-invalid={otpError ? true : undefined}
                  className="min-h-11 w-full min-w-0 rounded-md border border-[color:var(--color-hairline)] bg-[color:var(--color-canvas)] px-4 text-center font-mono text-xl tracking-[0.35em] text-[color:var(--color-ink)] outline-none transition placeholder:text-[color:var(--color-muted-soft)] focus:border-[color:var(--color-primary)] focus:ring-[3px] focus:ring-[color:var(--color-primary)]/15"
                  disabled={verifying}
                />
                <motion.button
                  type="submit"
                  disabled={otp.length !== 6 || verifying}
                  whileTap={{ scale: 0.97 }}
                  className="flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-md bg-[color:var(--color-primary)] px-4 text-sm font-medium text-[color:var(--color-on-primary)] transition-colors hover:bg-[color:var(--color-primary-active)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {verifying ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  {t("login.otp.submit")}
                </motion.button>
              </div>
              {otpError ? (
                <p role="alert" aria-live="polite" className="text-xs font-semibold text-[color:var(--color-error)]">
                  {otpError}
                </p>
              ) : (
                <p className="text-xs leading-relaxed text-[color:var(--color-muted)]">{t("login.otp.hint")}</p>
              )}
            </form>

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
