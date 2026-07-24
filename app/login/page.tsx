import { LoginForm } from "@/components/login-form";
import { LanguageProvider } from "@/lib/i18n";

// Public route (allow-listed in proxy.ts). Wrapped in LanguageProvider so the
// login UI gets full EN/HU parity like the rest of the app.
export default function LoginPage() {
  return (
    <LanguageProvider>
      <LoginForm />
    </LanguageProvider>
  );
}
