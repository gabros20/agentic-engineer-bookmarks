"use client";

import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/react";
import { Check, Loader2, PlugZap, X as XIcon } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";

import { LanguageSwitcher } from "@/components/language-switcher";
import { MCP_SCOPE } from "@/lib/mcp-scope";
import { type MessageKey, useLanguage } from "@/lib/i18n";

// Dedicated client for the consent POST: oauthProviderClient() attaches this page's SIGNED query
// string (`oauth_query`) to the request, which is how Better Auth ties the approval to the pending
// authorize request. Kept out of lib/auth-client.ts so ordinary app requests never carry it.
const consentClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
  plugins: [oauthProviderClient()],
});

const SCOPE_LABELS: Record<string, MessageKey> = {
  [MCP_SCOPE]: "consent.scope.bookmarks",
  profile: "consent.scope.profile",
  email: "consent.scope.profile",
  offline_access: "consent.scope.offline",
};

type Props = {
  clientName: string | null;
  clientUri: string | null;
  redirectHost: string | null;
  scopes: string[];
  email: string;
};

export function ConsentForm({ clientName, clientUri, redirectHost, scopes, email }: Props) {
  const { t } = useLanguage();
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // One line per distinct capability (profile + email share a label); `openid` needs no line.
  const scopeLines = Array.from(new Set(scopes.map((s) => SCOPE_LABELS[s]).filter(Boolean)));

  async function decide(accept: boolean) {
    if (busy) return;
    setBusy(accept ? "allow" : "deny");
    setError(null);
    try {
      const { data, error: consentError } = await consentClient.oauth2.consent({ accept });
      const url = (data as { url?: string } | null)?.url;
      if (consentError || !url) throw new Error("consent failed");
      // Back to the MCP client (with the code, or with access_denied on Deny).
      window.location.href = url;
    } catch {
      setError(t("consent.error"));
      setBusy(null);
    }
  }

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
          <PlugZap size={18} className="text-[color:var(--color-primary)]" />
          <h1 className="font-display text-[26px] leading-tight">{t("consent.title")}</h1>
        </div>

        <p className="mt-3 text-[15px] leading-relaxed text-[color:var(--color-ink)]">
          {t("consent.body", { client: name })}
        </p>
        {clientUri ? (
          <p className="mt-1 break-all text-xs text-[color:var(--color-muted)]">{clientUri}</p>
        ) : null}
        <p className="mt-1 text-xs text-[color:var(--color-muted)]">{email}</p>

        {scopeLines.length ? (
          <div className="mt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
              {t("consent.scopes")}
            </p>
            <ul className="mt-2 grid gap-1.5">
              {scopeLines.map((key) => (
                <li key={key} className="flex items-start gap-2 text-[14px] text-[color:var(--color-body)]">
                  <Check size={14} className="mt-[3px] shrink-0 text-[color:var(--color-primary)]" />
                  {t(key)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {redirectHost ? (
          <p className="mt-4 text-xs leading-relaxed text-[color:var(--color-muted)]">
            {t("consent.redirect", { host: redirectHost })}
          </p>
        ) : null}

        {error ? (
          <p role="alert" aria-live="polite" className="mt-3 text-xs font-semibold text-[color:var(--color-error)]">
            {error}
          </p>
        ) : null}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <motion.button
            type="button"
            onClick={() => decide(false)}
            disabled={busy !== null}
            whileTap={{ scale: 0.97 }}
            className="flex min-h-10 items-center justify-center gap-2 rounded-md border border-[color:var(--color-hairline)] px-4 text-sm font-medium text-[color:var(--color-ink)] transition-colors hover:bg-[color:var(--color-surface-cream-strong)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "deny" ? <Loader2 size={14} className="animate-spin" /> : <XIcon size={14} />}
            {t("consent.deny")}
          </motion.button>
          <motion.button
            type="button"
            onClick={() => decide(true)}
            disabled={busy !== null}
            whileTap={{ scale: 0.97 }}
            className="flex min-h-10 items-center justify-center gap-2 rounded-md bg-[color:var(--color-primary)] px-4 text-sm font-medium text-[color:var(--color-on-primary)] transition-colors hover:bg-[color:var(--color-primary-active)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy === "allow" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {t("consent.allow")}
          </motion.button>
        </div>
      </motion.div>
    </main>
  );
}
