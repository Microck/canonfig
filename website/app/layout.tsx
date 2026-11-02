import type { Metadata, Viewport } from "next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import "fumadocs-ui/style.css";
import "./global.css";

import { baseOptions } from "@/lib/layout";
import { basePath, siteUrl } from "@/lib/site";
import { source } from "@/lib/source";

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: "Canonfig documentation",
    template: "%s | Canonfig",
  },
  description:
    "Operate deterministic, one-way configuration synchronization across Source and Follower Machines.",
  applicationName: "Canonfig documentation",
  keywords: [
    "Canonfig",
    "configuration synchronization",
    "AI agents",
    "Machine Profile",
    "Follower Machine",
  ],
};

// Dark only, like the app. The browser bar takes --color-fd-background from app/ender-chest.css (dark).
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#0b0f10",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <RootProvider
          theme={{ enabled: false }}
          // Next does not add the base path to fetch() URLs, so the static
          // search index path spells it out (see app/api/search/route.ts).
          search={{ options: { type: "static", api: `${basePath}/api/search` } }}
        >
          <DocsLayout tree={source.pageTree} {...baseOptions}>
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
