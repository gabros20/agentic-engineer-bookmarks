"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Lang = "en" | "hu";

const STORAGE_KEY = "agentic-engineer-bookmarks:lang";

export const messages = {
  en: {
    "app.title": "X Bookmarks",
    "app.subtitle": "{n} saved posts searchable locally",
    "app.starred": "starred",
    "app.saved": "saved",
    "app.aria.savedDigests": "Saved digests",

    "search.placeholder": "Filter bookmarks",
    "search.precision.exact": "Exact",
    "search.precision.broad": "Broad",
    "search.precision.aria": "Search precision",

    "sort.newest": "Newest",
    "sort.oldest": "Oldest",
    "sort.bookmarks": "Saves",
    "sort.likes": "Likes",

    "scope.all": "All saved",
    "scope.favorites": "Starred",
    "scope.articles": "Articles",
    "scope.media": "Media",
    "scope.photos": "Photos",
    "scope.videos": "Videos",
    "scope.text": "Text only",

    "action.clear": "Clear",
    "action.aiDigest": "Digest top {n} with AI",
    "action.scrollTop": "Scroll to top",
    "action.loadMore": "Load {n} more",

    "status.semanticReady": "Semantic search ready",
    "status.keyword": "Keyword search",
    "status.exactWarming": "Exact semantic search warming up",
    "status.broadExpansionWarming": "Broad semantic expansion warming up",
    "status.broadWarming": "Broad semantic search warming up",
    "status.exactHybrid": "Exact hybrid search",
    "status.broadExpansion": "Broad hybrid expansion",
    "status.broadHybrid": "Broad hybrid search",
    "status.summary": "Showing {shown} of {total} matching saved posts · {status}",

    "empty.results": "No bookmarks match this filter.",

    "digest.title": "AI Digest",
    "digest.savedBadge": "SAVED",
    "digest.regenerate": "Regenerate",
    "digest.regenerateAria": "Regenerate with current top results",
    "digest.aria.close": "Close digest",
    "digest.sources": "{n} source",
    "digest.sourcesPlural": "{n} sources",
    "digest.savedAge": "saved {age}",
    "digest.error": "Could not generate digest.",
    "digest.startHere": "Where to start: ",
    "digest.empty": "No digest yet.",

    "saved.title": "Saved digests",
    "saved.empty": "No saved digests yet. Run an AI Digest from any search and it will be saved here for next time.",
    "saved.themes": "{n} theme",
    "saved.themesPlural": "{n} themes",
    "saved.delete": "Delete",
    "saved.aria.close": "Close",

    "unlock.title": "Unlock AI Digest",
    "unlock.hint": "Enter the passkey to enable AI digests on this device. Saved for 30 days.",
    "unlock.placeholder": "Passkey",
    "unlock.submit": "Unlock",
    "unlock.error.invalid": "Invalid passkey.",
    "unlock.error.generic": "Unlock failed ({code}).",
    "unlock.aria.close": "Close",

    "lang.label": "Language",
    "lang.en": "English",
    "lang.hu": "Magyar",

    "time.justNow": "just now",
    "time.minutes": "{n}m ago",
    "time.hours": "{n}h ago",
    "time.days": "{n}d ago",

    "chat.title": "Ask AI",
    "chat.placeholder": "Ask about your bookmarks…",
    "chat.empty": "Press ⌘K anytime. Ask about a topic, an author, a recent save — the AI can search your archive.",
    "chat.save": "Save",
    "chat.saved": "Saved",
    "chat.savedBadge": "SAVED",
    "chat.aria.close": "Close chat",
    "chat.contextSearch": "Context: {n} sources from \"{q}\"",
    "chat.contextNone": "No active search · the AI will use tools to look things up",
    "chat.openHint": "⌘K to chat",
  },
  hu: {
    "app.title": "X Könyvjelzők",
    "app.subtitle": "{n} mentett poszt, helyileg kereshető",
    "app.starred": "csillagozott",
    "app.saved": "mentett",
    "app.aria.savedDigests": "Mentett összegzések",

    "search.placeholder": "Könyvjelzők szűrése",
    "search.precision.exact": "Pontos",
    "search.precision.broad": "Kiterjesztett",
    "search.precision.aria": "Keresési pontosság",

    "sort.newest": "Legújabb",
    "sort.oldest": "Legrégebbi",
    "sort.bookmarks": "Mentések",
    "sort.likes": "Kedvelések",

    "scope.all": "Összes mentett",
    "scope.favorites": "Csillagozott",
    "scope.articles": "Cikkek",
    "scope.media": "Média",
    "scope.photos": "Képek",
    "scope.videos": "Videók",
    "scope.text": "Csak szöveg",

    "action.clear": "Törlés",
    "action.aiDigest": "Top {n} összegzése AI-val",
    "action.scrollTop": "Vissza a tetejére",
    "action.loadMore": "{n} további betöltése",

    "status.semanticReady": "Szemantikus kereső kész",
    "status.keyword": "Kulcsszó keresés",
    "status.exactWarming": "Pontos szemantikus keresés indul",
    "status.broadExpansionWarming": "Bő szemantikus bővítés indul",
    "status.broadWarming": "Bő szemantikus keresés indul",
    "status.exactHybrid": "Pontos hibrid keresés",
    "status.broadExpansion": "Bő hibrid bővítés",
    "status.broadHybrid": "Bő hibrid keresés",
    "status.summary": "{shown} megjelenítve · {total} mentett poszt · {status}",

    "empty.results": "Nincs ennek a szűrőnek megfelelő könyvjelző.",

    "digest.title": "AI Összegzés",
    "digest.savedBadge": "MENTVE",
    "digest.regenerate": "Újragenerálás",
    "digest.regenerateAria": "Újragenerálás az aktuális top találatokkal",
    "digest.aria.close": "Összegzés bezárása",
    "digest.sources": "{n} forrás",
    "digest.sourcesPlural": "{n} forrás",
    "digest.savedAge": "mentve {age}",
    "digest.error": "Nem sikerült létrehozni az összegzést.",
    "digest.startHere": "Hol kezdd: ",
    "digest.empty": "Még nincs összegzés.",

    "saved.title": "Mentett összegzések",
    "saved.empty": "Még nincs mentett összegzés. Futtass egy AI Összegzést bármilyen keresésre, és itt jelenik meg legközelebbre.",
    "saved.themes": "{n} téma",
    "saved.themesPlural": "{n} téma",
    "saved.delete": "Törlés",
    "saved.aria.close": "Bezárás",

    "unlock.title": "AI Összegzés feloldása",
    "unlock.hint": "Add meg a jelszót az AI Összegzés engedélyezéséhez ezen az eszközön. 30 napig megőrizve.",
    "unlock.placeholder": "Jelszó",
    "unlock.submit": "Feloldás",
    "unlock.error.invalid": "Érvénytelen jelszó.",
    "unlock.error.generic": "Feloldás sikertelen ({code}).",
    "unlock.aria.close": "Bezárás",

    "lang.label": "Nyelv",
    "lang.en": "English",
    "lang.hu": "Magyar",

    "time.justNow": "épp most",
    "time.minutes": "{n} perce",
    "time.hours": "{n} órája",
    "time.days": "{n} napja",

    "chat.title": "Kérdezz az AI-tól",
    "chat.placeholder": "Kérdezz a könyvjelzőkről…",
    "chat.empty": "Bármikor ⌘K. Kérdezz témáról, szerzőről, frissen mentettről — az AI átkutatja az archívumot.",
    "chat.save": "Mentés",
    "chat.saved": "Mentve",
    "chat.savedBadge": "MENTVE",
    "chat.aria.close": "Csevegés bezárása",
    "chat.contextSearch": "Kontextus: {n} forrás innen: \"{q}\"",
    "chat.contextNone": "Nincs aktív keresés · az AI eszközökkel keres majd",
    "chat.openHint": "⌘K csevegéshez",
  },
} as const;

export type MessageKey = keyof (typeof messages)["en"];

type LangContextValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
};

const LangContext = createContext<LangContextValue | null>(null);

function interpolate(template: string, vars?: Record<string, string | number>) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "en" || stored === "hu") setLangState(stored);
    } catch {
      // ignore
    }
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    if (typeof document !== "undefined") {
      document.documentElement.lang = next;
    }
  }, []);

  const t = useCallback<LangContextValue["t"]>(
    (key, vars) => interpolate(messages[lang][key] ?? key, vars),
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return createElement(LangContext.Provider, { value }, children);
}

export function useLanguage(): LangContextValue {
  const ctx = useContext(LangContext);
  if (!ctx) {
    // Safe default for any accidental render outside provider.
    return {
      lang: "en",
      setLang: () => undefined,
      t: (k, vars) => interpolate(messages.en[k] ?? k, vars),
    };
  }
  return ctx;
}
