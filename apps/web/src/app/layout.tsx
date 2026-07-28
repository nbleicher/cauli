import type { Metadata, Viewport } from "next";
import { DM_Sans, Poppins } from "next/font/google";
import { publicEnv } from "@/lib/env";
import "./globals.css";

export const dynamic = "force-dynamic";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display",
});

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: {
    default: "cauli",
    template: "%s | cauli",
  },
  description: "Record, transcribe, and review browser calls.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#FF6B5E",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${dmSans.variable}`}
      data-supabase-url={publicEnv.supabaseUrl || undefined}
      data-supabase-anon-key={publicEnv.supabaseAnonKey || undefined}
    >
      <body>{children}</body>
    </html>
  );
}
