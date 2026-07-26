import { render } from "@react-email/render";
import { Resend } from "resend";
import { MagicLinkEmail } from "@/emails/magic-link-email";

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
    html: await render(MagicLinkEmail({ url })),
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
