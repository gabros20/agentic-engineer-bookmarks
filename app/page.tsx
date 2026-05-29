import { BookmarksApp } from "@/components/bookmarks-app";
import { LanguageProvider } from "@/lib/i18n";

export default function Home() {
  return (
    <LanguageProvider>
      <BookmarksApp />
    </LanguageProvider>
  );
}
