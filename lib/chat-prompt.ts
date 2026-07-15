import type { DigestSource } from "@/lib/digest-schema";
import type { SavedDigest } from "@/lib/digest-cache";

export type ChatLang = "en" | "hu";

export type ChatContext = {
  language: ChatLang;
  query: string | null;
  precision: "exact" | "broad" | null;
  sources: DigestSource[];
  digest: SavedDigest | null;
  /** Live archive size (posts.length), threaded from the client. Task 14: replaces the
   *  hardcoded "~4,600"/"~4600" that drifted from the real (now 5,370+) count. `null`/
   *  missing/non-positive falls back to the original static text (see
   *  formatArchiveCount below) rather than printing a wrong or "~0" number. */
  archiveCount: number | null;
};

/**
 * "~N saved posts" text for the system prompt, rounded to the nearest hundred so it reads
 * as an approximation (matching the original hardcoded "~4,600"/"~4600") rather than an
 * exact, sync-drifting count. Falls back to the pre-Task-14 hardcoded figure when no live
 * count is available (e.g. an older client, or a request made before `posts` loaded
 * client-side) — same number the prompt always shipped with, so this is a safe default,
 * not a regression. EN uses a thousands separator ("~5,400"); HU does not
 * ("~5400") — matches the pre-existing locale convention in these two strings.
 */
function formatArchiveCount(archiveCount: number | null | undefined, lang: ChatLang): string {
  if (typeof archiveCount !== "number" || !Number.isFinite(archiveCount) || archiveCount <= 0) {
    return lang === "hu" ? "~4600" : "~4,600";
  }
  const rounded = Math.round(archiveCount / 100) * 100;
  return lang === "hu" ? `~${rounded}` : `~${rounded.toLocaleString("en-US")}`;
}

const systemEn = (countText: string) => `You are a research assistant embedded in Tamas's personal X (Twitter) bookmark archive (${countText} saved posts). The user opens you with Cmd-K and asks short questions about what they have saved.

How to answer
- Prefer the context the user is currently looking at (CURRENT_VIEW below) when it's relevant. Only call tools when the answer isn't already in view.
- When you cite a source, name the author and link the URL exactly as given. Never invent URLs or ids.
- Be brief. 2–6 sentences for most answers, a short bulleted list when the question is enumerative.
- If the answer truly isn't in the archive, say so plainly. Don't fabricate.

Tools
- search_bookmarks(query, precision?, limit?, filter?): hybrid keyword + semantic search over the whole archive. precision="exact" is best for handles / literal terms; "broad" is best for topics / vibes. Default limit 20.
- get_bookmark(id): full text (including article body if any) of one bookmark by id.

Respond in English.`;

const systemHu = (countText: string) => `Kutatási asszisztens vagy Tamas személyes X (Twitter) könyvjelző-archívumában (${countText} mentett poszt). A felhasználó a Cmd-K-val nyit meg téged, és rövid kérdéseket tesz fel a mentett tartalmairól.

Hogyan válaszolj
- Először az aktuálisan látható kontextust használd (lent: CURRENT_VIEW), ha releváns. Csak akkor hívj eszközt, ha az válasz nincs a látható nézetben.
- Forrás idézésekor a szerző nevét és a megadott URL-t pontosan használd. Soha ne találj ki URL-eket vagy id-ket.
- Légy tömör. A legtöbb válasz 2–6 mondat; felsorolásnál rövid pontok.
- Ha a válasz tényleg nincs az archívumban, mondd ki egyszerűen. Ne találj ki dolgokat.

Eszközök
- search_bookmarks(query, precision?, limit?, filter?): hibrid kulcsszó + szemantikus keresés a teljes archívumon. precision="exact" rövid, szó szerinti lekérdezésekre; "broad" témákra/megérzésekre. Alapértelmezett limit: 20.
- get_bookmark(id): egy adott könyvjelző teljes szövege (cikk-tartalommal együtt) id alapján.

Magyarul válaszolj.`;

function summarizeSources(sources: DigestSource[], lang: ChatLang) {
  if (!sources.length) return "";
  const heading = lang === "hu" ? "Aktuális top találatok" : "Currently visible top hits";
  const lines = sources.slice(0, 20).map((s, i) => {
    const article = s.articleTitle ? ` [article: ${s.articleTitle}]` : "";
    const snippet = s.text.length > 160 ? s.text.slice(0, 159) + "…" : s.text;
    const excerpt = s.articleExcerpt
      ? `\n   excerpt: ${s.articleExcerpt.length > 200 ? s.articleExcerpt.slice(0, 199) + "…" : s.articleExcerpt}`
      : "";
    return `${i + 1}. id=${s.id} @${s.screenName} (${s.author})${article}\n   ${snippet}${excerpt}\n   ${s.url}`;
  });
  return `\n${heading}:\n${lines.join("\n")}\n`;
}

function summarizeDigest(digest: SavedDigest | null, lang: ChatLang) {
  if (!digest) return "";
  const heading = lang === "hu"
    ? `Egy korábban mentett összegzés a "${digest.query}" lekérdezésre`
    : `A previously saved digest for query "${digest.query}"`;
  const themeLines = digest.themes.map((t, i) => {
    const sources = t.sources.slice(0, 4).map((s) => `${s.author} (id=${s.bookmarkId})`).join("; ");
    return `${i + 1}. ${t.title} — ${t.summary}\n   sources: ${sources}`;
  });
  const overallLabel = lang === "hu" ? "Összegzés" : "Overall";
  return `\n${heading}:\n${themeLines.join("\n")}\n${overallLabel}: ${digest.overall}\n`;
}

export function getChatSystemPrompt(lang: ChatLang, archiveCount: number | null = null) {
  const countText = formatArchiveCount(archiveCount, lang);
  return lang === "hu" ? systemHu(countText) : systemEn(countText);
}

export function buildChatContextBlock(context: ChatContext): string {
  const { language: lang, query, precision, sources, digest } = context;
  if (!query && !sources.length && !digest) {
    const empty = lang === "hu"
      ? "CURRENT_VIEW: a felhasználó még nem keresett semmit. Hívj eszközt, ha az archívumból kell információ."
      : "CURRENT_VIEW: the user has no active search. Call a tool if you need information from the archive.";
    return empty;
  }
  const header = lang === "hu" ? "CURRENT_VIEW" : "CURRENT_VIEW";
  const queryLine = query
    ? lang === "hu"
      ? `Aktív keresés: "${query}" (precision: ${precision ?? "?"})`
      : `Active search: "${query}" (precision: ${precision ?? "?"})`
    : "";
  return [header + ":", queryLine, summarizeSources(sources, lang), summarizeDigest(digest, lang)]
    .filter(Boolean)
    .join("\n");
}
