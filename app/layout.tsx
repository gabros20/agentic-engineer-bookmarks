import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter } from "next/font/google";
import { QueryProvider } from "@/components/shell/query-provider";
import { ScrollTopOnLoad } from "@/components/shell/scroll-top-on-load";
import "./globals.css";

// Inter is a variable font — omit `weight` so Next pulls the single
// variable woff2 that covers all weights instead of four static cuts.
const body = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-body",
  display: "swap",
});

// Instrument Serif: the editorial display face (hero search, titles). Static cuts — regular +
// italic only. Explicit fallback chain lets Next.js compute tight metric-overrides.
const display = Instrument_Serif({
  subsets: ["latin", "latin-ext"],
  weight: ["400"],
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
  fallback: ["Instrument Serif", "Tiempos Headline", "Georgia", "Times New Roman", "serif"],
});

// Applies a saved light/dark choice before first paint (no flash). "system" = no attribute, so
// the prefers-color-scheme rules in globals.css decide. Keep the key in sync with lib/theme.ts.
const themeScript = `try{var t=localStorage.getItem("xbookmarks:theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export const metadata: Metadata = {
  title: "X Bookmarks",
  description: "A searchable local collection of X bookmarks with AI digest.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#09090b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ScrollTopOnLoad />
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
