import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from "fumadocs-ui/layouts/docs/page";

import { getMDXComponents } from "@/mdx-components";
import { source } from "@/lib/source";

interface PageProperties {
  readonly params: Promise<{ readonly slug?: Array<string> }>;
}

export default async function DocumentationPage({
  params,
}: PageProperties) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (page === undefined) notFound();

  const Content = page.data.body;
  return (
    <DocsPage toc={page.data.toc}>
      <div id="main-content">
        <DocsTitle>{page.data.title}</DocsTitle>
        <DocsDescription>{page.data.description}</DocsDescription>
        <DocsBody>
          <Content components={getMDXComponents()} />
        </DocsBody>
      </div>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({
  params,
}: PageProperties): Promise<Metadata> {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (page === undefined) notFound();

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
    },
    openGraph: {
      type: "article",
      title: page.data.title,
      description: page.data.description,
      url: page.url,
    },
  };
}
