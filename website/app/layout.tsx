import type { Metadata, Viewport } from "next";

import { shareImage, siteUrl } from "@/lib/site";

// The root layout carries no stylesheet. The landing page at / and the
// Fumadocs tree at /docs are separate visual systems, so each segment layout
// imports its own: app/(landing)/layout.tsx and app/docs/layout.tsx. Links
// between the two are plain <a> elements, so each page load carries only its
// own CSS (the App Router keeps a visited segment's stylesheets loaded).
export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: "Canonfig",
    template: "%s | Canonfig",
  },
  description:
    "Keep your AI agent config in ~/.canonfig/. Canonfig writes each supported agent's files and syncs changes across your machines.",
  applicationName: "Canonfig",
  // Pages that set their own openGraph (docs pages) repeat the image there.
  // No page sets twitter, so this one applies everywhere.
  openGraph: {
    siteName: "Canonfig",
    images: [shareImage],
  },
  twitter: {
    card: "summary_large_image",
    images: [shareImage],
  },
};

// Dark only, like the app. The docs take their colors from .dark in
// app/docs/ender-chest.css; the landing page sets its own ground.
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0b0f10",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
