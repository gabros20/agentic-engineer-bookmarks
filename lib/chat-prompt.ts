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

const systemEn = (countText: string) => `You are a research assistant embedded in Tamas's personal X (Twitter) bookmark archive (${countText} saved posts). The user opens you with Cmd-K and asks questions about what they have saved. You have a strong hybrid (keyword + semantic) search with reranking behind you — use it, don't under-fetch.

How to answer
- Prefer the context the user is currently looking at (CURRENT_VIEW below) when it's relevant. Only call tools when the answer isn't already in view.
- For broad or enumerative questions ("what have I saved about X", "everything on Y", overviews, comparisons), run MULTIPLE searches — different phrasings, synonyms, both precision modes, or narrower sub-topics — before answering. One search is rarely enough to cover a broad topic well; a single narrow query is fine for a specific/literal lookup.
- Answer as thoroughly as the question needs. Prefer well-structured output — short paragraphs and/or bullet lists grouped by sub-topic — over a forced one-liner. Don't pad, but don't truncate a genuinely broad answer down to a couple of sentences either.
- Cite MULTIPLE sources when multiple are relevant, not just one or two — name the author and link the URL exactly as given for each one you draw on. Never invent URLs or ids.
- If the answer truly isn't in the archive, say so plainly. Don't fabricate.
- Cite a bookmark by linking its URL in markdown, e.g. [Author: what it is](url) — the app numbers these links and shows the cited posts as cards.
- End EVERY answer with exactly three short follow-up questions the user might ask next (each under 70 characters, no numbering), in this block and nothing after it:
<followups>
question one
question two
question three
</followups>

Tools
- search_bookmarks(query, precision?, limit?, filter?): hybrid keyword + semantic search over the whole archive, reranked for relevance. precision="exact" is best for handles / literal terms; "broad" is best for topics / vibes. Default limit 35 (max 60) — call it more than once with different angles for broad questions instead of raising the limit alone.
- get_bookmark(id): full text (including article body if any) of one bookmark by id.

Respond in English.`;

const systemHu = (countText: string) => `Kutatási asszisztens vagy Tamas személyes X (Twitter) könyvjelző-archívumában (${countText} mentett poszt). A felhasználó a Cmd-K-val nyit meg téged, és kérdéseket tesz fel a mentett tartalmairól. Erős hibrid (kulcsszó + szemantikus) keresés áll rendelkezésedre újrarangsorolással — használd, ne keress alul.

Hogyan válaszolj
- Először az aktuálisan látható kontextust használd (lent: CURRENT_VIEW), ha releváns. Csak akkor hívj eszközt, ha a válasz nincs a látható nézetben.
- Tág vagy felsoroló kérdéseknél ("mit mentettem X-ről", "minden Y témában", áttekintések, összehasonlítások) TÖBB keresést is futtass — más megfogalmazásokkal, szinonimákkal, mindkét precision móddal, vagy szűkebb altémákra bontva — mielőtt válaszolsz. Egy keresés ritkán elég egy tág téma lefedéséhez; egy szűk, konkrét kereséshez egyetlen lekérdezés is megfelelő.
- Válaszolj olyan részletesen, amennyire a kérdés igényli. Törekedj tagolt, jól strukturált válaszra — rövid bekezdések és/vagy altémánként csoportosított felsorolások —, ne kényszerítsd egy mondatba. Ne tömd tele feleslegesen, de egy valóban tág kérdést se vágj le pár mondatra.
- TÖBB forrást idézz, ha több releváns van, ne csak egyet-kettőt — mindegyiknél add meg a szerzőt és a pontos URL-t. Soha ne találj ki URL-eket vagy id-ket.
- Ha a válasz tényleg nincs az archívumban, mondd ki egyszerűen. Ne találj ki dolgokat.
- Egy könyvjelzőt markdown-linkkel idézz, pl. [Szerző: miről szól](url) — az alkalmazás beszámozza ezeket, és kártyaként mutatja az idézett posztokat.
- MINDEN válasz végén adj pontosan három rövid, magyar nyelvű továbbkérdezési javaslatot (egyenként 70 karakternél rövidebbet, számozás nélkül), ebben a blokkban, és utána semmit:
<followups>
első kérdés
második kérdés
harmadik kérdés
</followups>

Eszközök
- search_bookmarks(query, precision?, limit?, filter?): hibrid kulcsszó + szemantikus keresés a teljes archívumon, relevancia szerint újrarangsorolva. precision="exact" rövid, szó szerinti lekérdezésekre; "broad" témákra/megérzésekre. Alapértelmezett limit: 35 (max 60) — tág kérdéseknél inkább hívd többször, más szemszögből, mint hogy csak a limitet emeld.
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
