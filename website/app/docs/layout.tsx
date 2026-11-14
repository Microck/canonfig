import type { Metadata } from "next";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import "fumadocs-ui/style.css";
import "./global.css";

import { baseOptions } from "@/lib/layout";
import { source } from "@/lib/source";

export const metadata: Metadata = {
  title: {
    default: "Canonfig documentation",
    template: "%s | Canonfig",
  },
  description:
    "Operate deterministic, one-way configuration synchronization across Source and Follower Machines.",
  keywords: [
    "Canonfig",
    "configuration synchronization",
    "AI agents",
    "Machine Profile",
    "Follower Machine",
  ],
};

// The Fumadocs stylesheet and provider live here rather than in the root
// layout, so the landing page at / is not styled by the docs theme.
export default function Layout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <RootProvider
        theme={{ enabled: false }}
        // The search index is a static file the export writes once
        // (app/docs/api/search/route.ts); the browser searches it locally.
        search={{ options: { type: "static", api: "/docs/api/search" } }}
      >
        <DocsLayout tree={source.pageTree} {...baseOptions}>
          {children}
        </DocsLayout>
      </RootProvider>
    </>
  );
}
