import { ContinueAuthorize } from "@/components/continue-authorize";
import { LanguageProvider } from "@/lib/i18n";

// Where an app connection's magic link lands after signing in (components/login-form.tsx). Public
// like /login (proxy.ts) — it holds no data, it only forwards to the OAuth authorize endpoint.
export default function LoginContinuePage() {
  return (
    <LanguageProvider>
      <ContinueAuthorize />
    </LanguageProvider>
  );
}
