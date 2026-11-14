import { Fragment } from 'react';
import websitePackage from '@/package.json';
import { CopyCommand } from './copy-command';
import HeroDiagram from './demos/hero';
import { HarnessStrip } from './demos/harness-strip';
import { RevealOnScroll } from './demos/offscreen';
import { PublishScene } from './demos/publish';
import SafetyCards from './demos/safety';
import { DitherBand } from './dither-band';
import { Mark } from './mark';
import { revealDelay } from './reveal';
import './page.css';

// The release scripts bump website/package.json with every release.
const VERSION = websitePackage.version;
const REPO = 'https://github.com/Microck/canonfig';
const INSTALL = 'npm install --global @microck/canonfig';
const FIRST_SYNC = '/docs/tutorials/first-sync/';
// The demo is a separate app under /demo/, so use a plain link.
const DEMO = '/demo/';

/**
 * Links into /docs are plain <a> elements, not next/link: the docs are a
 * separate visual system whose stylesheet must not stay loaded on this page
 * (app/layout.tsx).
 */
export default function HomePage() {
  return (
    <>
      <RevealOnScroll />
      <SiteNav />
      <main id="main">
        <Hero />
        <HarnessStrip />
        <Safety />
        <Machines />
        <Surface />
      </main>
      <SiteFooter />
    </>
  );
}

/* ------------------------------------------------------------------ chrome --- */

function SiteNav() {
  return (
    <header className="nav">
      <a className="sa-sr nav-skip" href="#main">
        Skip to content
      </a>
      <div className="nav-inner">
        <a href="/" className="nav-brand">
          <Mark size={22} />
          <span>Canonfig</span>
          <span className="nav-version sa-mono">{VERSION}</span>
        </a>
        <nav className="nav-links" aria-label="Site">
          <a className="sa-btn sa-btn-ghost" href={REPO}>
            GitHub
          </a>
          <a className="sa-btn sa-btn-primary" href="/docs/">
            Read the docs
          </a>
        </nav>
      </div>
    </header>
  );
}

// The headline's words in reading order; the emphasised clause is green.
const HEADLINE = [
  { words: ['Use', 'the', 'same', 'AI', 'setup'], em: false },
  { words: ['on', 'every', 'machine.'], em: true },
];

// Intro timing (page.css `.intro`): one word every 80ms, then the lead and the
// buttons 100ms apart, then the map (hero.css) once the words have landed.
const WORD_STAGGER_MS = 80;
const LEAD_DELAY_MS = 420;

function Hero() {
  let word = 0;
  return (
    <section className="sa-grid hero" aria-labelledby="hero-title">
      <div className="hero-inner">
        <h1 className="hero-title" id="hero-title">
          {HEADLINE.map(({ words, em }) => {
            // The space sits outside each word: a moving word is inline-block,
            // which would swallow a trailing space of its own.
            const spans = words.map((text) => (
              <Fragment key={text}>
                <span className="intro intro-word" style={{ animationDelay: `${word++ * WORD_STAGGER_MS}ms` }}>
                  {text}
                </span>{' '}
              </Fragment>
            ));
            return em ? <em key="em">{spans}</em> : spans;
          })}
        </h1>
        <p className="hero-lead intro" style={{ animationDelay: `${LEAD_DELAY_MS}ms` }}>
          Edit ~/.canonfig/. Canonfig writes each agent's config files.
        </p>
        <div className="hero-actions intro" style={{ animationDelay: `${LEAD_DELAY_MS + 100}ms` }}>
          <a className="sa-btn sa-btn-primary" href={FIRST_SYNC}>
            Install Canonfig
            <Arrow />
          </a>
          <a className="sa-btn sa-btn-ghost" href={DEMO}>
            Try the demo
          </a>
        </div>
      </div>

      {/* The map stands on the GUI's dithered horizon, full width and faded
          out on every side, so the texture has no edge of its own. */}
      <div className="hero-map intro intro-fade" style={{ animationDelay: `${LEAD_DELAY_MS + 200}ms` }}>
        <DitherBand />
        <div className="hero-stage">
          <HeroDiagram />
        </div>
      </div>
    </section>
  );
}

function Safety() {
  return (
    <Section id="safety">
      <SectionHead title="What happens when you sync?" />
      <SafetyCards />
    </Section>
  );
}

/** The publish scene (demos/publish.tsx), framed as the link into the demo. */
function Machines() {
  return (
    <Section id="machines">
      <SectionHead title="Publish changes to your other machines." />
      <div className="rv" style={revealDelay(80)}>
        <a className="shot" href={DEMO}>
          <PublishScene />
          <span className="shot-caption">
            Try the interactive demo
            <Arrow />
          </span>
        </a>
      </div>
    </Section>
  );
}

/** What it does and does not do, one short line each (docs index, README). */
function Surface() {
  const does = [
    'Writes each agent\'s config files',
    'Signs and versions each revision',
    'Checks files after writing them',
    'Runs on Linux, macOS and Windows',
    'Syncs on a schedule',
  ];
  const doesNot = ['Copy changes back from followers', 'Change logins, sessions or history', 'Require a hosted service', 'Publish files you did not add'];

  return (
    <Section id="surface">
      <div className="checks">
        <div>
          <h2 className="sa-label rv" data-tone="ok" style={revealDelay(0)}>
            Canonfig
          </h2>
          <ul className="check-list" data-tone="ok">
            {does.map((item, index) => (
              <li key={item} className="rv" style={revealDelay(40 + index * 40)}>
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="sa-label rv" style={revealDelay(60)}>
            It doesn't
          </h2>
          <ul className="check-list" data-tone="off">
            {doesNot.map((item, index) => (
              <li key={item} className="rv" style={revealDelay(100 + index * 40)}>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Section>
  );
}

/**
 * The page closes on a single centered line and one button, on a tinted
 * full-bleed band that sits above the footer rather than inside main.
 */
function Closing() {
  return (
    <section className="sa-grid closing" aria-labelledby="closing-title" data-reveal>
      <div>
        <h2 className="sa-display rv" id="closing-title" style={revealDelay(0)}>
          Install Canonfig.
        </h2>
        <div className="rv" style={revealDelay(60)}>
          <CopyCommand command={INSTALL} />
        </div>
        <div className="closing-actions rv" style={revealDelay(120)}>
          <a className="sa-btn sa-btn-primary" href={FIRST_SYNC}>
            Sync your first two machines
            <Arrow />
          </a>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- primitives --- */

function Section({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <section id={id} className="sa-grid sa-section" data-reveal>
      <div>{children}</div>
    </section>
  );
}

/** A section heading rises before its content. */
function SectionHead({ title }: { title: string }) {
  return (
    <div className="sa-head rv" style={revealDelay(0)}>
      <h2>{title}</h2>
    </div>
  );
}

function Arrow() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SiteFooter() {
  const groups = [
    {
      title: 'Use Canonfig',
      links: [
        { label: 'First sync', href: FIRST_SYNC },
        {
          label: 'Publish from the folder',
          href: '/docs/how-to/publish-from-the-folder/',
        },
        { label: 'Choose harnesses', href: '/docs/how-to/choose-harnesses/' },
        {
          label: 'Restore from a backup',
          href: '/docs/how-to/restore-from-a-backup/',
        },
      ],
    },
    {
      title: 'Reference',
      links: [
        { label: 'Commands', href: '/docs/reference/cli/' },
        {
          label: 'The ~/.canonfig/ folder',
          href: '/docs/reference/canonfig-folder/',
        },
        { label: 'Harnesses', href: '/docs/reference/harnesses/' },
        {
          label: 'Platform differences',
          href: '/docs/reference/cross-platform/',
        },
      ],
    },
    {
      title: 'How it works',
      links: [
        {
          label: 'How Canonfig works',
          href: '/docs/explanation/architecture/',
        },
        { label: 'Security', href: '/docs/reference/security/' },
        { label: 'Recover a sync', href: '/docs/how-to/recover/' },
        { label: 'Interactive demo', href: DEMO },
      ],
    },
    {
      title: 'Project',
      links: [
        { label: 'GitHub', href: REPO },
        {
          label: 'npm package',
          href: 'https://www.npmjs.com/package/@microck/canonfig',
        },
        { label: 'Releases', href: `${REPO}/releases` },
        { label: 'MIT license', href: `${REPO}/blob/main/LICENSE` },
      ],
    },
  ];

  return (
    <footer className="foot">
      <Closing />
      <div className="sa-grid">
        <div className="foot-inner">
          <div className="foot-brand">
            <span className="foot-brand-name">
              <Mark size={22} />
              Canonfig {VERSION}
            </span>
          </div>
          {groups.map((group) => (
            <nav key={group.title} aria-label={group.title}>
              <h2 className="sa-label">{group.title}</h2>
              <ul>
                {group.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href}>{link.label}</a>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
      </div>
    </footer>
  );
}
