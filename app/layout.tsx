import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

/**
 * Fonts are SELF-HOSTED from app/fonts (fetched by scripts/fetch-fonts.mjs).
 *
 * These were next/font/google, which fetches from fonts.googleapis.com at BUILD
 * time. On 2026-08-11 that fetch failed inside the Docker build and took the
 * staging deploy with it — reported as "module not found" on a
 * geist_*.module.css, which reads like a code error and costs a diagnosis every
 * time. It passed on re-run, which is the point: the release path depended on a
 * third party being up, and would have failed eventually at a worse moment.
 *
 * Latin subsets only (what the app already declared) and variable files, so all
 * three faces cost 88KB in total and every weight in their range is available.
 * The CSS custom property names are unchanged, so globals.css is untouched.
 */
const geist = localFont({
  src: "./fonts/geist-latin.woff2",
  variable: "--font-geist",
  weight: "400 700",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/geist-mono-latin.woff2",
  variable: "--font-geist-mono",
  weight: "400 600",
  display: "swap",
  preload: false,
});

// Cormorant Garamond — the Marley Moves website heading face. Used for the
// brand wordmark (and available for display moments) so the panel logotype
// matches the public brand. Serif metrics for the fallback, so the swap from
// the system font doesn't reflow the wordmark.
const cormorant = localFont({
  src: "./fonts/cormorant-garamond-latin.woff2",
  variable: "--font-cormorant",
  weight: "500 700",
  display: "swap",
  adjustFontFallback: "Times New Roman",
});

export const metadata: Metadata = {
  title: "Marley Ops",
  description: "Marley Moves internal operations panel",
  // PWA: installable (required for iOS Web Push — Home Screen only).
  appleWebApp: { capable: true, title: "Marley Ops", statusBarStyle: "black" },
  icons: { apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#18181b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} ${cormorant.variable} h-full`}>
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
