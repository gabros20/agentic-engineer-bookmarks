import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Inter } from "next/font/google";
import "./globals.css";

// Inter is a variable font — omit `weight` so Next pulls the single
// variable woff2 that covers all weights instead of four static cuts.
const body = Inter({
  subsets: ["latin", "latin-ext"],
  variable: "--font-body",
  display: "swap",
});

// Cormorant Garamond is NOT variable on Google Fonts — keep the one weight.
// Explicit fallback chain lets Next.js compute tighter metric-overrides
// (adjustFontFallback is on by default), shortening the visible swap.
const display = Cormorant_Garamond({
  subsets: ["latin", "latin-ext"],
  weight: ["700"],
  variable: "--font-display",
  display: "swap",
  fallback: ["Cormorant Garamond", "EB Garamond", "Garamond", "Times New Roman", "serif"],
});

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
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body>{children}</body>
    </html>
  );
}
