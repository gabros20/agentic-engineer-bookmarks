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

// Bilingual (EN + HU) magic-link email, built with React Email so it renders to
// email-client-safe HTML. Sent from lib/email.ts via @react-email/render. We send
// BOTH languages because the recipient's language isn't known at send time; each
// block carries its own actionable button + paste-link (EN/HU parity).

type MagicLinkEmailProps = { url: string };

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

const footer = {
  color: MUTED,
  fontSize: "12px",
  lineHeight: "1.5",
  margin: "24px 0 0",
};

function LangBlock({
  url,
  heading: h,
  body,
  cta,
  fallback,
}: {
  url: string;
  heading: string;
  body: string;
  cta: string;
  fallback: string;
}) {
  return (
    <Section>
      <Heading style={heading}>{h}</Heading>
      <Text style={paragraph}>{body}</Text>
      <Button href={url} style={button}>
        {cta}
      </Button>
      <Text style={fallbackLabel}>{fallback}</Text>
      <Text style={fallbackLink}>
        <Link href={url} style={fallbackLink}>
          {url}
        </Link>
      </Text>
    </Section>
  );
}

export function MagicLinkEmail({ url }: MagicLinkEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Your sign-in link for X Bookmarks</Preview>
      <Body style={main}>
        <Container style={card}>
          <Text style={wordmark}>🔖 X Bookmarks</Text>

          <LangBlock
            url={url}
            heading="Sign in"
            body="Click below to sign in. The link expires in a few minutes and can be used once."
            cta="Sign in"
            fallback="Or paste this link into your browser:"
          />

          <Hr style={divider} />

          <LangBlock
            url={url}
            heading="Belépés"
            body="Kattints a belépéshez. A link néhány percen belül lejár, és egyszer használható."
            cta="Belépés"
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
