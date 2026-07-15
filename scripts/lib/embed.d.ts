// Typed wrapper for scripts/lib/embed.mjs (Task 14 single-sourcing).
//
// This repo has `allowJs: false`, so TS cannot infer types straight from the .mjs source —
// without this file, importing embed.mjs from a .ts/.tsx call site (lib/bookmark-search.ts,
// components/bookmarks-app.tsx) would implicitly type every export as `any` (TS7016).
// This file is signatures ONLY; embed.mjs remains the single source of truth for behavior.
// Keep in lockstep by hand — there's no build step that generates this from the .mjs.
//
// Resolution note: TS's "bundler" moduleResolution only auto-pairs a `.mjs` SPECIFIER with a
// `.d.mts` declaration file, not a same-named `.d.ts` (verified: a sibling `embed.d.ts` next
// to `embed.mjs` is NOT picked up for `import ... from ".../embed.mjs"`). Call sites in this
// repo therefore import the EXTENSION-LESS specifier (`@/scripts/lib/embed`), which bundler
// resolution matches against this `embed.d.ts` directly; Next/webpack's own resolver (a
// separate, later step, not governed by tsconfig) then resolves that same extension-less
// specifier to `embed.mjs` on disk, so both sides end up pointing at the same JS.
import type { BookmarkPost } from "@/lib/bookmark-types";

export declare const EMBED_MODEL: string;
export declare const PREFIX_SCHEME: "e5";

/** The text fed to the embedder for a BookmarkPost (post-normalization). */
export declare function searchText(post: BookmarkPost): string;

/** e5 "passage: " prefixed document text — what gets embedded for each indexed post. */
export declare function passageText(post: BookmarkPost): string;

/** int8-quantize a normalized float embedding (matches the on-disk encoding). */
export declare function quantizeEmbedding(data: Iterable<number>): number[];

/** Split article markdown into ~280-word title-prefixed chunks (index schema v2). */
export declare function chunkArticle(markdown: string | undefined | null, title?: string): string[];

/** Items to embed for a post: one main entry, plus one `{ part, text }` per article chunk. */
export declare function embedItemsForPost(post: BookmarkPost): Array<{ part?: number; text: string }>;

/**
 * e5 asymmetric QUERY-side prefix for a loaded search index (or index-shaped object): ""
 * for a v1 index, "query: " for an "e5" index. See embed.mjs for the full doc comment.
 */
export declare function queryPrefix(indexLike: { prefix_scheme?: string } | null | undefined): string;
