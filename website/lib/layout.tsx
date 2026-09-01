import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import React from "react";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: (
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <img src="/logo.png" alt="" width={24} height={24} />
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
  ],
};
