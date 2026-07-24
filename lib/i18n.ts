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
    "app.subtitle": "{n} saved posts · AI-powered search",
    "app.starred": "starred",
    "app.saved": "saved",
    "app.aria.savedDigests": "Saved digests",

    "search.placeholder": "Filter bookmarks",
    "search.precision.exact": "Exact",
    "search.precision.broad": "Broad",
    "search.precision.aria": "Search precision",
    "search.operator.aria.remove": "Remove filter: {label}",

    "sort.relevance": "Relevance",
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
    // T2 review F1 (CTA label fix): was "Digest top {n} with AI" where {n} came from
    // visiblePosts.length BEFORE the async ~50-source Worker re-query resolved — misstated
    // the real digest scope. Count-free copy now; no {n} arg passed at the call site.
    "action.aiDigest": "Digest with AI",
    "action.aiShortlist": "Shortlist with AI",
    "action.scrollTop": "Scroll to top",
    "action.loadMore": "Load {n} more",

    "status.ready": "Semantic search ready",
    "status.searching": "Searching…",
    "status.results": "Semantic search results",
    "status.offline": "Search offline — basic text match",
    "status.searchQuota": "Daily search limit reached — basic text match",
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
    "digest.limit": "Daily digest limit reached. Try again tomorrow.",
    "digest.startHere": "Where to start: ",
    "digest.empty": "No digest yet.",
    "digest.tldr": "TL;DR",
    "digest.themes": "Themes",
    "digest.readFirst": "Read first",
    "digest.deeperReads": "Deeper reads",

    "saved.title": "Saved digests",
    "saved.empty": "No saved digests yet. Run an AI Digest from any search and it will be saved here for next time.",
    "saved.loading": "Loading…",
    "saved.error": "Couldn't load your saved digests. Please try again.",
    "saved.themes": "{n} theme",
    "saved.themesPlural": "{n} themes",
    "saved.delete": "Delete",
    "saved.deleteError": "Couldn't delete that. Please try again.",
    "saved.aria.close": "Close",

    "auth.signOut": "Sign out",

    "login.title": "Sign in",
    "login.hint": "Enter your invite code and email. We'll send a magic link to sign in.",
    "login.code.label": "Invite code",
    "login.code.placeholder": "Invite code",
    "login.email.label": "Email",
    "login.email.placeholder": "you@example.com",
    "login.submit": "Send magic link",
    "login.error.generic": "Something went wrong. Please try again.",
    "login.error.link": "Could not send the magic link. Please try again.",
    "login.sent.title": "Check your email",
    "login.sent.body": "We sent a sign-in link to {email}. Open it on this device to continue.",
    "login.sent.back": "Use a different email",

    "lang.label": "Language",
    "lang.en": "English",
    "lang.hu": "Magyar",

    "time.justNow": "just now",
    "time.minutes": "{n}m ago",
    "time.hours": "{n}h ago",
    "time.days": "{n}d ago",

    "chat.title": "Ask AI",
    "chat.history": "Chat history",
    "chat.placeholder": "Ask about your bookmarks…",
    "chat.empty": "Press ⌘K anytime. Ask about a topic, an author, a recent save — the AI can search your archive.",
    "chat.loading": "Loading…",
    "chat.error": "Couldn't load your saved chats. Please try again.",
    "chat.limit": "Daily chat limit reached. Try again tomorrow.",
    "chat.reopenError": "Couldn't open that chat. Please try again.",
    "chat.deleteError": "Couldn't delete that. Please try again.",
    "chat.save": "Save",
    "chat.saved": "Saved",
    "chat.savedBadge": "SAVED",
    "chat.aria.close": "Close chat",
    "chat.contextSearch": "Context: {n} sources from \"{q}\"",
    "chat.contextNone": "No active search · the AI will use tools to look things up",
    "chat.openHint": "⌘K to chat",
    "chat.shortlistPrompt": "Shortlist the best {q} from my saved bookmarks. Return a numbered list ordered by relevance, each item with the title, a short description, and the link.",
  },
  hu: {
    "app.title": "X Könyvjelzők",
    "app.subtitle": "{n} mentett poszt · AI-alapú keresés",
    "app.starred": "csillagozott",
    "app.saved": "mentett",
    "app.aria.savedDigests": "Mentett összegzések",

    "search.placeholder": "Könyvjelzők szűrése",
    "search.precision.exact": "Pontos",
    "search.precision.broad": "Kiterjesztett",
    "search.precision.aria": "Keresési pontosság",
    "search.operator.aria.remove": "Szűrő eltávolítása: {label}",

    "sort.relevance": "Relevancia",
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
    "action.aiDigest": "Összegzés AI-val",
    "action.aiShortlist": "Rövid lista AI-val",
    "action.scrollTop": "Vissza a tetejére",
    "action.loadMore": "{n} további betöltése",

    "status.ready": "Szemantikus kereső kész",
    "status.searching": "Keresés…",
    "status.results": "Szemantikus találatok",
    "status.offline": "Kereső nem elérhető — egyszerű szövegtalálat",
    "status.searchQuota": "Elérted a napi keresési limitet — egyszerű szövegtalálat",
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
    "digest.limit": "Elérted a napi összegzési limitet. Próbáld újra holnap.",
    "digest.startHere": "Hol kezdd: ",
    "digest.empty": "Még nincs összegzés.",
    "digest.tldr": "Röviden",
    "digest.themes": "Témák",
    "digest.readFirst": "Kezdd ezekkel",
    "digest.deeperReads": "Hosszabb olvasmányok",

    "saved.title": "Mentett összegzések",
    "saved.empty": "Még nincs mentett összegzés. Futtass egy AI Összegzést bármilyen keresésre, és itt jelenik meg legközelebbre.",
    "saved.loading": "Betöltés…",
    "saved.error": "Nem sikerült betölteni a mentett összegzéseket. Próbáld újra.",
    "saved.themes": "{n} téma",
    "saved.themesPlural": "{n} téma",
    "saved.delete": "Törlés",
    "saved.deleteError": "Nem sikerült törölni. Próbáld újra.",
    "saved.aria.close": "Bezárás",

    "auth.signOut": "Kijelentkezés",

    "login.title": "Bejelentkezés",
    "login.hint": "Add meg a meghívókódot és az e-mail-címed. Küldünk egy bűvös linket a bejelentkezéshez.",
    "login.code.label": "Meghívókód",
    "login.code.placeholder": "Meghívókód",
    "login.email.label": "E-mail",
    "login.email.placeholder": "te@pelda.hu",
    "login.submit": "Bűvös link küldése",
    "login.error.generic": "Valami hiba történt. Kérlek, próbáld újra.",
    "login.error.link": "Nem sikerült elküldeni a bűvös linket. Kérlek, próbáld újra.",
    "login.sent.title": "Nézd meg az e-mailed",
    "login.sent.body": "Küldtünk egy bejelentkezési linket ide: {email}. Nyisd meg ezen az eszközön a folytatáshoz.",
    "login.sent.back": "Másik e-mail megadása",

    "lang.label": "Nyelv",
    "lang.en": "English",
    "lang.hu": "Magyar",

    "time.justNow": "épp most",
    "time.minutes": "{n} perce",
    "time.hours": "{n} órája",
    "time.days": "{n} napja",

    "chat.title": "Kérdezz az AI-tól",
    "chat.history": "Csevegés-előzmények",
    "chat.placeholder": "Kérdezz a könyvjelzőkről…",
    "chat.empty": "Bármikor ⌘K. Kérdezz témáról, szerzőről, frissen mentettről — az AI átkutatja az archívumot.",
    "chat.loading": "Betöltés…",
    "chat.error": "Nem sikerült betölteni a mentett csevegéseket. Próbáld újra.",
    "chat.limit": "Elérted a napi csevegési limitet. Próbáld újra holnap.",
    "chat.reopenError": "Nem sikerült megnyitni a csevegést. Próbáld újra.",
    "chat.deleteError": "Nem sikerült törölni. Próbáld újra.",
    "chat.save": "Mentés",
    "chat.saved": "Mentve",
    "chat.savedBadge": "MENTVE",
    "chat.aria.close": "Csevegés bezárása",
    "chat.contextSearch": "Kontextus: {n} forrás innen: \"{q}\"",
    "chat.contextNone": "Nincs aktív keresés · az AI eszközökkel keres majd",
    "chat.openHint": "⌘K csevegéshez",
    "chat.shortlistPrompt": "Készíts rövid listát a legjobb {q} eredményekről a mentett könyvjelzőim közül. Számozott, relevancia szerint rendezett lista legyen, minden tételnél a cím, rövid leírás és link.",
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
