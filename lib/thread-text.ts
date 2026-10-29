/**
 * The author's thread under a post as plain text (each continuation post's text, t.co
 * media links stripped, one paragraph per post) — what search indexes for it. Mirrored
 * verbatim by scripts/lib/search-core.mjs's threadText (the build-time index side).
 */
export function threadText(post: { thread?: Array<{ text?: string }> }): string {
  return (post.thread ?? [])
    .map((p) => (p.text ?? "").replace(/\s*https?:\/\/t\.co\/\w+/g, "").trim())
    .filter(Boolean)
    .join("\n\n");
}
