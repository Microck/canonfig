import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import React from "react";

// A static import gives a hashed /_next/static/media/... URL.
import logo from "@/public/logo.png";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <img src={logo.src} alt="" width={24} height={24} />
        <span style={{ fontWeight: 600 }}>Canonfig</span>
      </div>
    ),
    url: "/docs",
  },
  // The docs are dark only (app/docs/layout.tsx disables the theme provider), so a theme toggle would do nothing.
  themeSwitch: { enabled: false },
  links: [
    {
      text: "CLI reference",
      url: "/docs/reference/cli",
      active: "nested-url",
    },
    {
      // The demo is a separate app under /demo/. Use a plain <a>, not a Next link.
      text: "Try the demo",
      url: "/demo/",
      external: true,
      active: "none",
    },
  ],
};
