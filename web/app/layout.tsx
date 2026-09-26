import type { Metadata } from "next";
import { headers } from "next/headers";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const plexSans = IBM_Plex_Sans({
  variable: "--font-sans-stack",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});
const plexMono = IBM_Plex_Mono({
  variable: "--font-mono-stack",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "ENSCA — identity-gated infrastructure",
  description:
    "Your ENS subname is the credential for the network. Organizations, branches, roles and entitlements, read straight from ENS.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookies = (await headers()).get("cookie");

  return (
    <html
      lang="en"
      className={`${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-paper font-sans text-ink">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:border focus:border-ink focus:bg-paper focus:px-4 focus:py-2 focus:font-mono focus:text-xs"
        >
          Skip to content
        </a>
        <Providers cookies={cookies}>{children}</Providers>
      </body>
    </html>
  );
}
