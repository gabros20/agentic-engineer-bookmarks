import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { BookmarksApp } from "@/components/bookmarks-app";
import { auth } from "@/lib/auth";
import { LanguageProvider } from "@/lib/i18n";

// Authoritative auth gate (T3). The proxy is only an optimistic cookie check;
// this server-side session lookup is the real wall — a forged or edited cookie
// fails `getSession` here, so the app shell never renders without a valid,
// DB-backed session. Unauthenticated → /login.
export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/login");
  }

  return (
    <LanguageProvider>
      <BookmarksApp />
    </LanguageProvider>
  );
}
