import type { Metadata } from 'next';
import { shareImage } from '@/lib/site';
import localFont from 'next/font/local';
import './landing.css';

// Canonfig's own faces, the ones the GUI uses (ui/src/index.css): Manrope for
// prose, Ioskeley Mono for anything a terminal would print. Licences sit next
// to the files. next/font emits them under /_next/.
const sans = localFont({
  src: './fonts/Manrope.woff2',
  weight: '200 800',
  display: 'swap',
  variable: '--cf-font-sans',
});

const mono = localFont({
  src: [
    { path: './fonts/IoskeleyMono-Regular.woff2', weight: '400' },
    { path: './fonts/IoskeleyMono-Medium.woff2', weight: '500' },
  ],
  display: 'swap',
  variable: '--cf-font-mono',
});

const TITLE = 'Canonfig: one AI agent setup on every machine';
const DESCRIPTION =
  'Keep your AI agent config in ~/.canonfig/. Canonfig writes the files for Claude Code, Codex and 14 other agents, then syncs changes across your machines.';

// openGraph replaces the root layout's as a whole, so it repeats the image.
export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: { type: 'website', siteName: 'Canonfig', title: TITLE, description: DESCRIPTION, url: '/', images: [shareImage] },
};

// Runs while the page parses, before anything paints.
// - Marks <html> with data-js, so sections that rise into view on scroll are
//   only hidden when the script that reveals them can run (page.css).
// - The hero's intro plays once per browser session: it marks <html> as seen,
//   which page.css and hero.css read to skip the intro. sessionStorage, not
//   localStorage, so a new visit gets the intro again. Without JavaScript or
//   storage the intro just plays.
const INTRO_GATE = `document.documentElement.dataset.js='1';try{var k='canonfig-intro';if(sessionStorage.getItem(k))document.documentElement.dataset.intro='seen';else sessionStorage.setItem(k,'1')}catch(e){}`;

// `.sa` scopes every landing token, so nothing here reaches /docs.
export default function LandingLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className={`sa ${sans.variable} ${mono.variable}`}>
      <script dangerouslySetInnerHTML={{ __html: INTRO_GATE }} />
      {children}
    </div>
  );
}
