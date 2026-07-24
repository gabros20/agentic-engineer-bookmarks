import { Resend } from "resend";

// ---------------------------------------------------------------------------
// Transactional email via Resend. Bilingual (EN + HU) magic-link email.
// Secrets stay server-side; this module is never imported into client code.
// Note: without a verified domain, Resend only delivers to the account owner's
// own address — fine for a single-owner app; verify a domain to invite others.
// ---------------------------------------------------------------------------

// Resend's onboarding sender works without domain verification. Override via
// EMAIL_FROM once a domain is verified.
const FROM = process.env.EMAIL_FROM ?? "X Bookmarks <onboarding@resend.dev>";

let client: Resend | null = null;
function getClient(): Resend {
  if (!client) {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY is not set");
    client = new Resend(key);
  }
  return client;
}

export async function sendMagicLinkEmail({
  email,
  url,
}: {
  email: string;
  url: string;
}): Promise<void> {
  const { error } = await getClient().emails.send({
    from: FROM,
    to: email,
    subject: "Your sign-in link / Belépési linked",
    text: buildText(url),
    html: buildHtml(url),
  });
  if (error) {
    // Surface a generic failure; do not leak provider internals to callers.
    throw new Error(`Failed to send magic-link email: ${error.message}`);
  }
}

function buildText(url: string): string {
  return [
    "Sign in to X Bookmarks",
    "",
    `Click the link below to sign in. It expires in a few minutes and can be used once.`,
    url,
    "",
    "If you didn't request this, you can ignore this email.",
    "",
    "— — —",
    "",
    "Belépés az X Könyvjelzőkbe",
    "",
    "Kattints az alábbi linkre a belépéshez. Néhány percen belül lejár, és egyszer használható.",
    url,
    "",
    "Ha nem te kérted, nyugodtan hagyd figyelmen kívül ezt az e-mailt.",
  ].join("\n");
}

function buildHtml(url: string): string {
  // Each language block carries its OWN button + paste-link fallback so a
  // HU-first reader gets an actionable link in their own section (EN/HU parity).
  const button = (label: string) =>
    `<a href="${url}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${label}</a>`;
  return `<!-- bilingual EN/HU magic-link email -->
<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:0 auto;color:#111;line-height:1.5">
  <h2 style="margin:0 0 8px">Sign in to X Bookmarks</h2>
  <p style="margin:0 0 16px;color:#444">Click below to sign in. The link expires in a few minutes and can be used once.</p>
  <p style="margin:0 0 24px">${button("Sign in")}</p>
  <p style="margin:0 0 8px;color:#666;font-size:13px">Or paste this link into your browser:</p>
  <p style="margin:0 0 24px;word-break:break-all;font-size:13px"><a href="${url}">${url}</a></p>
  <hr style="border:none;border-top:1px solid #eee;margin:24px 0" />
  <h2 style="margin:0 0 8px">Belépés az X Könyvjelzőkbe</h2>
  <p style="margin:0 0 16px;color:#444">Kattints a belépéshez. A link néhány percen belül lejár, és egyszer használható.</p>
  <p style="margin:0 0 24px">${button("Belépés")}</p>
  <p style="margin:0 0 8px;color:#666;font-size:13px">Vagy másold be ezt a linket a böngésződbe:</p>
  <p style="margin:0 0 24px;word-break:break-all;font-size:13px"><a href="${url}">${url}</a></p>
  <p style="margin:0 0 8px;color:#666;font-size:13px">Ha nem te kérted, hagyd figyelmen kívül ezt az e-mailt.</p>
</div>`;
}
