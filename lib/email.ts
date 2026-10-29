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

/**
 * The sign-in email: a magic link and/or a 6-digit code (see emails/magic-link-email.tsx).
 * The login page sends both in one email (app/api/login/send); the bare Better Auth endpoints
 * send one or the other.
 */
export async function sendMagicLinkEmail({
  email,
  url,
  otp,
}: {
  email: string;
  url?: string;
  otp?: string;
}): Promise<void> {
  const { error } = await getClient().emails.send({
    from: FROM,
    to: email,
    subject: otp ? `${otp} — X Bookmarks sign-in / belépés` : "Your sign-in link / Belépési linked",
    text: buildText(url, otp),
    html: await render(MagicLinkEmail({ url, otp })),
  });
  if (error) {
    // Surface a generic failure; do not leak provider internals to callers.
    throw new Error(`Failed to send magic-link email: ${error.message}`);
  }
}

function buildText(url?: string, otp?: string): string {
  const lines = (linkLine: string, codeLine: string, ignore: string) => [
    ...(url ? [linkLine, url, ""] : []),
    ...(otp ? [codeLine, otp, ""] : []),
    ignore,
  ];
  return [
    "Sign in to X Bookmarks",
    "",
    ...lines(
      "Open this link to sign in on this device (expires in 10 minutes, works once):",
      "Signing in on another device (e.g. the computer running Claude Code)? Enter this code there:",
      "If you didn't request this, you can ignore this email.",
    ),
    "",
    "— — —",
    "",
    "Belépés az X Könyvjelzőkbe",
    "",
    ...lines(
      "Nyisd meg ezt a linket a belépéshez ezen az eszközön (10 percig érvényes, egyszer használható):",
      "Másik eszközön lépsz be (pl. a Claude Code-ot futtató számítógépen)? Ott írd be ezt a kódot:",
      "Ha nem te kérted, nyugodtan hagyd figyelmen kívül ezt az e-mailt.",
    ),
  ].join("\n");
}
