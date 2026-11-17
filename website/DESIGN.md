# Canonfig landing page design

The design language for the landing page at `canonfig.micr.dev/`. The landing
page and the Fumadocs documentation at `/docs` are separate visual systems:
this document governs `app/(landing)/` only, and nothing there is imported by
the docs tree. The page's visual system (grid, type scale, spacing, cards, nav,
closing band, footer) is ported from the Satelle site (github.com/Microck/satelle,
`website/app/(landing)/`), which took its layout from a reference marketing
site; comments that mention "the reference" mean that site. Satelle's demos
were about driving a remote desktop. None of that metaphor carries over: no
draggable windows, no control glow, no mouse pointer, no orbiting devices.

## Pictures first

Each section is a diagram a reader understands at a glance. Words are labels,
a heading, and at most one short line under it. No paragraphs, no terminal
transcripts: the docs carry the detail.

| Section | Picture | Source of truth |
| --- | --- | --- |
| Hero | The GUI's machine map: atlas holds `~/.canonfig/` and feeds laptop, studio, gaming-pc and build-box, each showing the logos of the harnesses it runs | The demo's machines (`ui/src/shared/data.ts`); harness mix is illustrative (`demos/hero.tsx`) |
| Harness band (logo-wall slot) | The 16 harness logos and names in one slow, endless row | `content/docs/reference/harnesses.mdx` (`demos/harnesses.tsx`, `demos/harness-strip.tsx`) |
| What happens when you sync? | Four pieces of the GUI: the Backups list, a map edge gone amber for Follower Drift, the item-by-machine matrix, the Source feeding three followers | The demo's data (`ui/src/shared/data.ts`) and behaviour rerun on scratch machines (`demos/safety.tsx`) |
| Publish scene (was the screenshot) | The GUI's Overview, drawn: a pointer presses Publish revision 8, the header goes from 1 unpublished change to Everything is published while its band turns from amber to green, and each follower's row fills a dithered progress bar and lands on rev 8 | The GUI's header states (`ui/src/workspace/source.tsx`) and the demo's machines (`demos/publish.tsx`) |
| Does / doesn't | Two rows of short check chips | The docs index and README |

## 1. What the page has to say

Canonfig is a one-way configuration synchronizer for AI agent setups. The page
has to make three things obvious, in this order:

1. One folder, `~/.canonfig/`, becomes every harness's own files.
2. One Source Machine publishes; every Follower Machine follows and never
   publishes back.
3. Canonfig says what it changes before it changes it, backs up what it
   replaces, and says out loud what it does not do.

### Voice

Use plain words and complete sentences. Describe what Canonfig does rather
than promising safety or saying it handles everything. Keep the copy short;
the diagrams carry the explanation. Use straight quotes and no em dashes.
Keep actual file names and GUI labels unchanged. The product terms in
the glossary in `AGENTS.md` belong where the reader needs that distinction.

The landing page is `/`, the demo is `/demo/` and the docs are `/docs/`.
Demo links are plain anchors because the demo is a separate Vite app.

### What the page must never contain

- Testimonials, logos, or quotes.
- Any capability the current release does not have.
- Text that does not describe the current release. File names, machine names
  and states must match what canonfig and the interactive demo show.

## 2. Color

Dark only, like the GUI (`ui/DESIGN.md`) and the docs. The palette is the Ender
palette from `ui/src/index.css`; `app/(landing)/landing.css` lays it out as a
twelve-step ramp plus roles.

| Token | Value | Use |
| --- | --- | --- |
| `--sa-0` | `#080b0c` | recessed wells: terminals, code |
| `--sa-1` | `#0b0f10` | page ground |
| `--sa-2` | `#0f1617` | raised surface: cards, window bodies |
| `--sa-3` | `#142021` | window chrome, tab strips |
| `--sa-4`, `--sa-5` | `#182728`, `#1f2e2f` | hovered and pressed surfaces |
| `--sa-6`, `--sa-7` | `#263738`, `#334646` | hairline and interactive borders |
| `--sa-8` | `#4d6460` | strong border. Never text |
| `--sa-9` | GUI `faint` | faint text |
| `--sa-10` | GUI `muted-foreground` | muted text |
| `--sa-11` | `#c9d6cf` | secondary text |
| `--sa-12` | `#e5eee9` | primary text |

Roles follow the GUI's rules:

- Gold (`--sa-cta`) is the one action per view that commits: the primary
  button. Nothing else is gold, and gold never sits beside a status.
- Ender green (`--sa-accent`, `--sa-accent-text`) marks the current thing: the
  active tab, the current step, the hero's emphasis.
- Violet (`--sa-focus`) is focus only.
- The GUI's dither palette (`--sa-dither-*`) colours machines in the pictures,
  as their accents do on the GUI's map.
- State colors (`--sa-ok`, `--sa-warn`, `--sa-act`, `--sa-fail`) report machine
  state and always sit next to a word that says the same thing.

### Texture

Ordered dithering is the only texture, as in the GUI (`ui/docs/design/dither.md`),
and it appears where the GUI puts it:

- The hero map stands on the GUI's state-band field (`dither-band.tsx`): the
  still frame of its calm horizon, Bayer 4x4 in 2px cells at 45%, full width
  behind the map. An elliptical mask wholly inside its box fades it out on
  every side, so it has no edge of its own. A canvas draws it once per size;
  it never animates. No gradient slab sits under the map.
- The pictures use the GUI's fills as SVG patterns (`dither.tsx`): the map's
  dithered icon tiles, and the matrix's solid (up to date), hatched (edited
  there) and dotted (not sent) cells.

Dither never runs behind text: the map's cards are opaque, and the headline
sits on the plain ground.

## 3. Type

Manrope for prose and Ioskeley Mono for anything a terminal would print, the
GUI's two faces, loaded with `next/font/local` from `app/(landing)/fonts/` (OFL
licences beside the files). Ligatures stay off so code shows the characters a
terminal prints.

The page runs two registers and never blends them inside one block: editorial
(sans) for headlines and prose, operator (mono) for commands, paths, harness
ids, outcomes and labels inside demo chrome. Headings sit at weight 500 and
carry emphasis by size and color.

The scale is fluid (Utopia, 320px to 1215px): `--step--2` to `--step-6`, with
matching `--space-*` steps.

## 4. Motion

Most of the page moves, by request, built to Emil Kowalski's rules (the
`emil-animations` and `emil-marketing-pages` skills): motion explains what
Canonfig does, answers the visitor's own press or focus, or enters once. One
departure, also by request: sections below the hero rise into view as they
are first scrolled to, which `emil-marketing-pages` advises against. They
play once and never replay. Parallax and scroll hijacking stay out.

Tokens (`landing.css`): `--mo-state` 150ms and `--mo-ease-flat` for colour
changes, `--mo-ease-out` (`cubic-bezier(0.23, 1, 0.32, 1)`) for anything that
enters or responds, `--mo-ease-in-out` (`cubic-bezier(0.77, 0, 0.175, 1)`)
for things travelling on screen. Only `transform`/`scale`/`translate`,
`opacity`, `clip-path` and stroke dash offsets animate.

- **Intro, once per session.** The headline rises word by word (8px out of a
  2px blur, 350ms, 80ms apart), then the lead, the buttons and the map fade
  in; the map's edges wipe down from atlas and the followers settle in turn. A
  script in `layout.tsx` marks the session as seen before the hero paints, so
  later loads show everything in place.
- **Sections rise in once, on first scroll** (`RevealOnScroll` in
  `demos/offscreen.tsx`, `reveal.ts`, page.css): the logo strip, Safe by
  default, the publish scene, does/doesn't and the closing band. Each piece
  fades up 8px over 400ms, heading first, cards 60ms apart, chips 40ms apart.
  Content is hidden only while JavaScript can reveal it (`data-js`, set in
  `layout.tsx`) and motion is allowed. The nav and footer do not move.
- **The map's sync loop.** Every 4.8s a short green pulse runs down each edge,
  140ms apart, and each follower's ring lights as it lands.
- **The logo strip.** About 33px a second (96s a loop), held on hover with a
  real pointer. There is no pause button, by request; without it the strip
  misses WCAG 2.2.2 for keyboard and touch users, and reduced motion is their
  way to stop it.
- **Card films, on a loop**, like Satelle's scenes: Restored moves to the
  second snapshot and back (6s), an amber pulse reaches studio and its ring
  lights (4.8s), the up-to-date cells light down the rows and along the
  machines (6s), a pulse lands on every follower (4.8s). Staggered through
  `--sweep` (`safety.tsx`).
- **The publish scene**, on a 10s loop (`publish.css` has the timeline): the
  pointer arrives and presses at 15%, the header runs through Publishing,
  Sending and Everything is published, each row fills its bar and lands on
  rev 8 250ms apart, and the end state holds until 94%. The row stagger fits
  inside the cycle's last 6%, so no row resets out of step with the header.
- Every loop pauses while off screen (`demos/offscreen.tsx`).
- **Press feedback.** Buttons give to `scale(0.97)`, the cards and the
  publish scene's frame to `0.985` (large surfaces give less), 160ms.
- Under `prefers-reduced-motion`, nothing moves: `landing.css` cuts every
  duration and delay, so the intro, loops and demos land on their end states
  at once.

## 5. The parts

- `demos/hero.tsx`: the hero map. `demos/machine.tsx` holds the GUI's machine
  icons and dithered icon tile, shared with the cards.
- `demos/harnesses.tsx`: the harness list and `HarnessLogo`, a mask over the
  text colour so every logo shares one tone. The SVGs live in
  `public/harnesses/`: 14 from `@lobehub/icons-static-svg` 1.102.0 (MIT,
  `LICENSE-lobehub-icons.txt`), Oh My Pi from its repo's `assets/icon.svg`
  (MIT, `LICENSE-oh-my-pi.txt`, connector slots cut out instead of painted),
  and Factory Droid from `Factory-AI/factory` `docs/favicon.svg` (white
  background square removed).
- `dither.tsx`: the GUI's fill patterns and its band's horizon field, ported.
  `dither-band.tsx` draws the band. Keep both in step with `ui/src/lib/dither`
  and `StateBand` in `ui/src/shared/shared.tsx` when the GUI's texture changes.
- `demos/safety.tsx`: the four GUI pictures, as SVG so each scales as one.
  Machine icons are the GUI's Solar paths.
- `demos/publish.tsx`: the publish scene, built from the same pieces: the
  state band, icon tiles and the GUI's dithered progress fill (`ramp-x`).

Machine names follow the interactive demo (`ui/src/shared/data.ts`), so the
landing page and the demo tell one story. When a harness is added or renamed,
update `demos/harnesses.tsx` and add its logo. When the GUI's Overview wording
changes, update `demos/publish.tsx`.
