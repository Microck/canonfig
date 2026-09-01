import type { Metadata } from "next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import "fumadocs-ui/style.css";
import "./global.css";

import { baseOptions } from "@/lib/layout";
import { siteUrl } from "@/lib/site";
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

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <RootProvider theme={{ enabled: false }}>
          <DocsLayout tree={source.pageTree} {...baseOptions}>
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
