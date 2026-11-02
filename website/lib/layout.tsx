import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import React from "react";

// A static import gives a /docs/_next/static/media/... URL that carries the
// base path; a plain "/logo.png" string would point outside the docs.
import logo from "@/public/logo.png";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <img src={logo.src} alt="" width={24} height={24} />
        <span style={{ fontWeight: 600 }}>Canonfig</span>
      </div>
    ),
    url: "/",
  },
  links: [
    {
      text: "CLI reference",
      url: "/reference/cli",
      active: "nested-url",
    },
    {
      // The demo is a separate app at the site root, outside the Next base
      // path. `external` renders a plain <a href="/"> instead of a Next link,
      // which would rewrite "/" to "/docs/". Active matching compares against
      // the docs pathname without its base path, so "/" would light up on
      // the docs home; `active: "none"` keeps it a plain link.
      text: "Try the demo",
      url: "/",
      external: true,
      active: "none",
    },
  ],
};
