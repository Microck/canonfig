import { DocsLayout } from "fumadocs-ui/layouts/docs";

import { baseOptions } from "@/lib/layout";
import { source } from "@/lib/source";

export default function DocumentationLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <DocsLayout tree={source.pageTree} {...baseOptions}>
      {children}
    </DocsLayout>
  );
}
