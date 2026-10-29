import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components";

// Bilingual (EN + HU) sign-in email, built with React Email so it renders to
// email-client-safe HTML. Sent from lib/email.ts via @react-email/render. We send
// BOTH languages because the recipient's language isn't known at send time; each
// block carries its own actionable button + paste-link (EN/HU parity).
//
// It carries two ways in: the link (one tap, signs in the device that opens it) and a
// 6-digit code to TYPE on the device where sign-in started — for reading mail on a phone
// while signing in on a computer (e.g. connecting Claude Code, which waits on that
// computer). Either can be absent (the plain endpoints send one or the other).

type MagicLinkEmailProps = { url?: string; otp?: string };

const BRAND = "#111827";
const MUTED = "#6b7280";
const HAIRLINE = "#e5e7eb";
const CANVAS = "#f6f6f7";

const main = {
  backgroundColor: CANVAS,
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  margin: 0,
  padding: "32px 0",
};

const card = {
  backgroundColor: "#ffffff",
  border: `1px solid ${HAIRLINE}`,
  borderRadius: "12px",
  margin: "0 auto",
  maxWidth: "480px",
  padding: "32px",
};

const wordmark = {
  color: BRAND,
  fontSize: "15px",
  fontWeight: 700,
  letterSpacing: "-0.01em",
  margin: "0 0 24px",
};

const heading = {
  color: BRAND,
  fontSize: "20px",
  fontWeight: 700,
  lineHeight: "1.3",
  margin: "0 0 8px",
};

const paragraph = {
  color: "#374151",
  fontSize: "14px",
  lineHeight: "1.55",
  margin: "0 0 20px",
};

const button = {
  backgroundColor: BRAND,
  borderRadius: "8px",
  color: "#ffffff",
  display: "inline-block",
  fontSize: "14px",
  fontWeight: 600,
  padding: "12px 22px",
  textDecoration: "none",
};

const fallbackLabel = {
  color: MUTED,
  fontSize: "12px",
  margin: "20px 0 4px",
};

const fallbackLink = {
  color: MUTED,
  fontSize: "12px",
  lineHeight: "1.5",
  margin: 0,
  wordBreak: "break-all" as const,
};

const divider = { borderColor: HAIRLINE, margin: "28px 0" };

const codeLabel = {
  color: MUTED,
  fontSize: "12px",
  margin: "22px 0 6px",
};

const codeBox = {
  backgroundColor: CANVAS,
  border: `1px solid ${HAIRLINE}`,
  borderRadius: "8px",
  color: BRAND,
  display: "inline-block",
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: "26px",
  fontWeight: 700,
  letterSpacing: "0.3em",
  margin: 0,
  padding: "10px 16px 10px 22px",
};

const footer = {
  color: MUTED,
  fontSize: "12px",
  lineHeight: "1.5",
  margin: "24px 0 0",
};

function LangBlock({
  url,
  otp,
  heading: h,
  body,
  cta,
  codeHint,
  fallback,
}: {
  url?: string;
  otp?: string;
  heading: string;
  body: string;
  cta: string;
  codeHint: string;
  fallback: string;
}) {
  return (
    <Section>
      <Heading style={heading}>{h}</Heading>
      <Text style={paragraph}>{body}</Text>
      {url ? (
        <Button href={url} style={button}>
          {cta}
        </Button>
      ) : null}
      {otp ? (
        <>
          <Text style={codeLabel}>{codeHint}</Text>
          <Text style={codeBox}>{otp}</Text>
        </>
      ) : null}
      {url ? (
        <>
          <Text style={fallbackLabel}>{fallback}</Text>
          <Text style={fallbackLink}>
            <Link href={url} style={fallbackLink}>
              {url}
            </Link>
          </Text>
        </>
      ) : null}
    </Section>
  );
}

export function MagicLinkEmail({ url, otp }: MagicLinkEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{otp ? `Your X Bookmarks sign-in code: ${otp}` : "Your sign-in link for X Bookmarks"}</Preview>
      <Body style={main}>
        <Container style={card}>
          <Text style={wordmark}>🔖 X Bookmarks</Text>

          <LangBlock
            url={url}
            otp={otp}
            heading="Sign in"
            body={
              url && otp
                ? "Tap the button to sign in on this device — or type the code on the device where you started (e.g. the computer running Claude Code). Both expire in 10 minutes and work once."
                : url
                  ? "Click below to sign in. The link expires in 10 minutes and can be used once."
                  : "Type this code where you started signing in. It expires in 10 minutes."
            }
            cta="Sign in on this device"
            codeHint="Signing in on another device? Enter this code there:"
            fallback="Or paste this link into your browser:"
          />

          <Hr style={divider} />

          <LangBlock
            url={url}
            otp={otp}
            heading="Belépés"
            body={
              url && otp
                ? "Koppints a gombra a belépéshez ezen az eszközön — vagy írd be a kódot azon az eszközön, ahol elkezdted (pl. a Claude Code-ot futtató számítógépen). Mindkettő 10 percig érvényes, és egyszer használható."
                : url
                  ? "Kattints a belépéshez. A link 10 percig érvényes, és egyszer használható."
                  : "Írd be ezt a kódot ott, ahol elkezdted a belépést. 10 percig érvényes."
            }
            cta="Belépés ezen az eszközön"
            codeHint="Másik eszközön lépsz be? Ott írd be ezt a kódot:"
            fallback="Vagy másold be ezt a linket a böngésződbe:"
          />

          <Text style={footer}>
            If you didn&rsquo;t request this, you can safely ignore this email. ·
            Ha nem te kérted, nyugodtan hagyd figyelmen kívül.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default MagicLinkEmail;
