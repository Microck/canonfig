import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export const baseOptions: BaseLayoutProps = {
  nav: {
    title: "Canonfig",
    url: "/",
  },
  links: [
    {
      text: "Documentation",
      url: "/docs",
      active: "nested-url",
    },
    {
      text: "CLI reference",
      url: "/docs/reference/cli",
      active: "nested-url",
    },
  ],
};
