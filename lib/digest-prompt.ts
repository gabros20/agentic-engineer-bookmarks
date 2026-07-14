import type { DigestSource } from "@/lib/digest-schema";

export type DigestLang = "en" | "hu";

const SYSTEM_PROMPT_EN = `You are a research assistant who turns a noisy list of bookmarked X (Twitter) posts into a small, scannable digest for the user.

Rules:
- You will be given a search query and 1–60 candidate sources that already matched the query locally. Your job is to cluster them into 2–6 themes, not to rank or filter for relevance from scratch.
- A theme must group sources that genuinely share an angle (e.g. "Hands-on prompting tutorials", "Critiques of the agentic hype"). If sources don't cluster, prefer fewer broader themes over many one-source themes.
- For every source you include: bookmarkId MUST be copied verbatim from the input; url MUST be copied verbatim; author should be the display name from the input; gist is 8–14 words explaining why THIS source is worth opening for the query (not a summary of the tweet's content).
- Drop sources that are clearly off-topic for the query rather than forcing them into a theme.
- Keep the overall takeaway to ONE sentence telling the user where to start.
- Be concrete. Avoid filler like "this post discusses…" or "useful for understanding…".
- Respond in English.`;

const SYSTEM_PROMPT_HU = `Kutatási asszisztens vagy: egy zajos X (Twitter) könyvjelző-listából rövid, gyorsan átfutható összegzést készítesz a felhasználónak.

Szabályok:
- Kapsz egy keresési lekérdezést és 1–60 jelölt forrást, amelyek már helyileg illeszkedtek a lekérdezésre. A feladatod ezek 2–6 témára való csoportosítása, nem pedig új relevancia-szűrés vagy rangsorolás.
- Egy téma valódi közös szemszöget kell mutasson (pl. "Gyakorlati prompt-útmutatók", "Az agentic-hype kritikái"). Ha nem klaszterezhetők jól, inkább kevesebb, szélesebb témát adj, mintsem sok egy-forrásos témát.
- Minden forrásnál: a bookmarkId-t SZÓ SZERINT a bemenetből kell másolni; az url-t SZÓ SZERINT a bemenetből kell másolni; a szerző a bemenet display neve legyen; a gist 8–14 szavas magyarázat arra, hogy MIÉRT érdemes EZT a forrást megnyitni a lekérdezéshez (nem a tweet tartalmának összefoglalása).
- A nyilvánvalóan a lekérdezéstől eltérő forrásokat hagyd ki ahelyett, hogy erőltetetten témákba sorolnád őket.
- A "Hol kezdd" összegzést tartsd EGY mondatban: hova nézzen először a felhasználó.
- Légy konkrét. Kerüld a tölteléket, mint "ez a poszt arról szól…" vagy "hasznos a megértéséhez…".
- Magyarul válaszolj.`;

export function getDigestSystemPrompt(lang: DigestLang) {
  return lang === "hu" ? SYSTEM_PROMPT_HU : SYSTEM_PROMPT_EN;
}

export function buildDigestUserPrompt(query: string, sources: DigestSource[], lang: DigestLang) {
  const lines = sources.map((s, i) => {
    const article = s.articleTitle ? ` [article: ${s.articleTitle}]` : "";
    const excerpt = s.articleExcerpt ? `\n   excerpt: ${s.articleExcerpt}` : "";
    return `${i + 1}. id=${s.id} @${s.screenName} (${s.author})${article}\n   ${s.text}${excerpt}\n   ${s.url}`;
  });

  if (lang === "hu") {
    return `Lekérdezés: ${query}

Jelölt források (helyi hibrid kereső már illesztette):

${lines.join("\n\n")}

Készítsd el az összegzést most.`;
  }

  return `Query: ${query}

Candidate sources (already matched by local hybrid search):

${lines.join("\n\n")}

Produce the digest now.`;
}
