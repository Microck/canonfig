# Canonfig UI

The browser frontend lives in `ui/`. Workspace screens are in `src/workspace/`, shared components and demo data in `src/shared/`, and first-run setup in `src/onboarding/`. See [the architecture decision](../docs/adr/0001-local-browser-gui.md).

Machine operations still use simulated data in every build. The Demo panel selects a Source, Follower or new machine; it does not connect to a real machine. CLI serving and backend integration are not implemented yet, so this frontend is not included in the published CLI package.

Run from the repository root:

```bash
npm --prefix ui ci
npm run ui:dev
```

Open `http://localhost:5317/source/overview`. The independent frontend lockfile stays in `ui/package-lock.json`. Root scripts `ui:typecheck`, `ui:lint` and `ui:build` delegate to this package. Production CLI packaging remains separate.

## Builds

| Command | Output | Use |
| --- | --- | --- |
| `npm --prefix ui run build` | `ui/dist/` | The app `canonfig ui` will serve on loopback |
| `npm --prefix ui run build:demo` | `ui/dist-demo/` | The public demo at https://canonfig.micr.dev/, published to GitHub Pages with the docs under `/docs/` |

`DEMO` in `src/shared/data.ts` is true for the demo build (Vite mode `demo`) and the dev server, and false for the production build, which drops the code it gates. It gates only demo chrome:

- the Demo panel (`src/shared/demo-switcher.tsx`): an "Interactive demo with made-up data" note, the role links, and links to the docs, the install tutorial and the GitHub repository. It sits in the desktop sidebar, at the bottom-left of setup and not-found pages from 768px, and behind a Demo button in the mobile top bar and setup header;
- copy that describes the demo itself, such as "Saved in this demo workspace" and "This demo discards it";
- the simulated first-visit page load (`SIMULATED_LOAD_MS`), which imitates the real fetch; production shows each page at once;
- the `?star=1` preview.

Both builds still run on the simulated data in `src/shared/data.ts` and `src/workspace/store.tsx` until the loopback backend lands; the production build has no real data path yet. Simulated actions such as Check for updates keep their short waits in both builds.

The demo build also replaces the page title and adds a description, canonical URL, and Open Graph and Twitter card tags to `index.html`, and writes `404.html` as a copy of it, so GitHub Pages boots the app on deep links such as `/follower/sync`. `vite.config.ts` holds this in its `demoSite` plugin. The theme colour and viewport tags sit in `index.html` itself, so both builds have them. The site assembly (`scripts/build-pages.mjs`) adds the docs and `robots.txt`.

### Share image

The demo build also emits `og-image.png` at the site root and points `og:image` and `twitter:image` at `https://canonfig.micr.dev/og-image.png`; the docs use the same URL (`website/app/layout.tsx`). The file lives in `scripts/`, not `public/`, so the production build does not ship it. `scripts/og-image.html` is its source: the demo's machine map (`scripts/og-image-map.png`, a capture of `/source/machines` at 880x650 CSS pixels and 2x scale with reduced motion, the default layout and toasts hidden), cropped under the chest, the wordmark and the onboarding line, with the fonts in `public/fonts`. Recapture the map after the map's look changes; after changing either file, render and compress the image from `ui/`:

```bash
npx playwright@1.58.2 screenshot --viewport-size=1200,630 --wait-for-timeout=500 "file://$PWD/scripts/og-image.html" scripts/og-image.png
optipng -o7 -strip all scripts/og-image.png
```

Keep the wordmark and tagline inside the central 1200x600: X and Slack crop the image to about 2:1.

## Browser routes

The URL selects the role, screen and view tab. Links can be opened directly or refreshed, and browser Back/Forward follows navigation. `/` opens `/source/overview`; unknown or role-invalid paths show a not-found page.

| Screen | Source | Follower |
| --- | --- | --- |
| Overview | `/source/overview` | `/follower/overview` |
| Profile items | `/source/profile` | |
| Profile harnesses | `/source/profile/harnesses` | |
| Profile groups | `/source/profile/groups` | |
| Profile defaults | `/source/profile/defaults` | |
| Machine map | `/source/machines` | `/follower/machines` |
| Machine list | `/source/machines/list` | `/follower/machines/list` |
| Revisions | `/source/revisions` | |
| Backups | `/source/backups` | `/follower/backups` |
| Secrets | `/source/secrets` | `/follower/secrets` |
| Sync | | `/follower/sync` |
| Schedule | | `/follower/schedule` |
| Local settings (`~/.canonfig/local/`, overlays, append-local content, harness exclusions, backups) | | `/follower/local-settings` |
| Service | `/source/settings/service` | |
| Agent policy | `/source/settings/agent` | `/follower/settings/agent` |
| Installers | `/source/settings/installers` | |
| Machine setup | `/source/settings/setup` | |
| Health check | `/source/settings/health` | `/follower/settings/health` |
| SSH tunnel | | `/follower/settings/tunnel` |
| Enrollment | | `/follower/settings/enrollment` |
| Canonfig version (self-update) | `/source/settings/version` | `/follower/settings/version` |

First-run setup is `/setup`. Retired role and variant query parameters are not routing aliases.

## Guidance and presentation

Guidance lives in `src/workspace/guide.tsx`, with the spotlight component in `src/tour/`. It has three parts, remembered per role in localStorage: a tour offer on the first visit that opens the tour picker (a four-stop quick tour, then one chapter per area), a Get started list on Overview, and one tip on the first visit to a complex page. Take the tour, in the sidebar or the command palette, opens a picker with that short tour and one chapter of three to five stops per area (`src/workspace/tour-steps.tsx`). Selecting a chapter previews its steps and the pages it visits, numbered in order on a copy of the sidebar, so each chapter's `pages` list must match where its steps go. Finished chapters get a tick, can run again, and end with a button to the next chapter. Append `?tour=1` to start the short tour; reopen a page tip from its "?" button.

After 15 minutes with the workspace on screen, counted across visits and only while its tab is visible and focused, a toast asks for a GitHub star (`StarPrompt` in `src/workspace/guide.tsx`). It waits while the tour, its offer, a page tip or a dialog is open. Any way of closing it stops it for good. In the demo, append `?star=1` to show it straight away.

In the demo, workspace pages pretend to fetch their data from the local Canonfig service, as the real GUI will. The first visit to each page (each Profile and Machines tab counts as its own) in a page load waits `SIMULATED_LOAD_MS` (700ms, in `src/workspace/store.tsx`) and shows a loading skeleton over the page body and the detail panel's body and footer; page headers, the sidebar and dialogs never load. Sync's Check for updates and the Follower's Update secrets show it again while they run, in both builds. Pages a tour opens, or that are open while the tour or its picker is, don't load, and a page's first-visit tip waits until its content is revealed. Skeletons come from [skullet](https://github.com/lochie/skullet) (MIT), pinned at 0.0.3: `Body` in `src/workspace/kit.tsx` measures them from the real content, so nothing moves on reveal, and `App.tsx` themes them to the palette. The highlight sweep and fades stop under reduced motion. Mark decorative art with `skullet-ignore` so it draws no placeholder.

The machine map in `src/shared/machine-map/` also runs alone at `/map-demo.html?role=source|follower`, with `&publishing=1`, `&syncing=<follower ids>` and `&customize=<id>`. This separate component demo and `/break.html` are development-only entrypoints served by `vite`, not application routes; neither build includes them.

The spotlight uses separate blur panels and a rounded dimming cutout. The card, cutout and blur switch targets together without a trailing animation. Tour and map controls have 40px minimum hit targets, increasing to 44px for coarse pointers. Map customization lives in the selected machine's unscaled toolbar.

Initial map fitting and Fit to screen never shrink nodes below their natural size, keeping node text at least 11px at narrow widths. Pan to reach the remaining machines, or zoom out manually. Keyboard focus and selection pan the node and its Open/Customize toolbar into view without changing zoom; hovering does not pan. Reduced motion makes these pans instant.

Single-step tips open from the page's "?" button without dimming or blurring the app. A tip never covers an open detail panel or the header actions (elements marked `data-tip-avoid`); it prefers a spot below the "?" that also clears the page's controls, such as the empty area under a list, and otherwise sits as close to the "?" as those regions allow. When no spot is free, as with a full-screen detail panel on a phone, the first-visit tip waits until the panel closes; the "?" still opens it on demand. Their heading sits beside the close button; only multi-step tours reserve a separate progress row. Tour and tip buttons draw at 28px, with invisible hit areas extending to 40px or 44px for coarse pointers.

Interface text sizing stays separate from the browser's root font size, so text sizing does not shrink the spacing scale. Desktop uses a 244px sidebar, 44px page headers, 28px view pills and 44px interactive list rows with a 36px inner highlight. Group headers remain 36px. Page titles use 15px/600 at a consistent 18px header inset; parent context follows the title on desktop. Below 768px, the title and help button occupy the first row, with page actions in a separate wrapping row when present.

Settings and form columns share an 880px maximum width and left alignment. Blocks within one column share its edges: Overview's Get started list and item-by-machine table sit in the main column and end where its lists do, and intros, notices and the Sync band above a list keep their text at the list's 18px inset. Profile, Sync, local-settings, secrets and settings lists cap their name/item columns at 240px and path/target columns at 360px where applicable; the final column takes spare space. Narrow lists retain horizontal scrolling rather than compressing their columns.

Use `variant="primary"` for at most one gold commit/create action per view. Default and secondary buttons are neutral; outline buttons are for toolbar and row actions, ghost buttons for unobtrusive controls, and destructive buttons use red text and a faint red tint. Disabled buttons use dashed borders, muted text and a not-allowed cursor, with no hover or press treatment. Green is not a button fill.

Below 768px, a navigation sheet replaces the sidebar. It traps focus and closes on Escape or any navigation link, including the current page. The desktop sidebar scrolls independently in short windows. Its Demo panel stays in the sidebar flow. Below 768px, workspace screens show a compact 44px Demo disclosure button at the right of the top bar, and setup and not-found pages show it in the header; from 768px setup and not-found pages keep the full panel at the bottom-left.

Profile settings edits include unfinished key rows: adding a blank key enables Save and Discard. Save reports empty or duplicate key names without changing the saved item, focuses the first invalid field, and associates each key error with its input. Discard restores the saved fields and key rows.

Machine-owned content follows ADR 0003 section 11. Profile → Defaults edits `local.allow` (now including `instructions`, which is `local/AGENTS.md`) and `local.appendLocal` (instructions files, skills folders). Profile items include authored `resources.<id>` under "Files outside harnesses": a file or directory with `replace` or `append-local`, or a config merge of keys; the editor refuses a target outside `~/`, with a `.` or `..` segment, overlapping another resource, or overlapping `~/.canonfig`, `~/.agents` or any adapter's paths (`RESERVED_PATHS` in `src/shared/data.ts`, taken from the adapters' default Linux and macOS layouts), quoting Canonfig's own messages. On a Follower, Local settings lists Local Overlays and unsettled name collisions, with set ("Let mine replace it") and remove; an unsettled collision disables Apply on Sync, as the engine stops the run. The local item editor offers the same overlay when a name or settings key collides. Local settings also lists key claims (`settings/<harness>#<key>` entries of the same `overlays` list) under "Settings keys you set yourself", with add and remove; adding refuses a harness without a settings file, a key the harness keeps for itself, a key inside a value Canonfig writes whole, and a key the machine's local settings also set (`SETTINGS_FILES` in `src/shared/data.ts`, held equal to the adapters by a test), quoting Canonfig's messages. Local settings also lists what append-local keeps of the machine's own text and skills. Sync's first adoptions of an append-local file get a review step, the GUI's `sync --plan --review-local`: on request it shows the exact text Canonfig adds, the text it keeps and the whole file, and can delete the private review.
A skill's detail panel on the Source has an Upstream section for `canonfig skills` (`src/workspace/skills.tsx`). A tracked skill shows its repository, the branch, tag or commit it follows and the commit its copy came from. Check for updates lists the new, changed and removed files before anything changes; Update replaces the skill in the folder with that commit, marks it modified for the next revision and is held back while the panel has unsaved edits. A copy edited since Canonfig installed it shows why it can't update, and Update checks again before it replaces anything, so an edit saved after the last check still blocks it. An untracked skill offers Track upstream…, which records the source only when every file matches. The list's Summary shows the ref a tracked skill follows, or the last check's state when it found something. The demo fetches only `https://github.com/example/agent-skills.git`, from `upstreamSkills` in `src/shared/data.ts`.

While a skill update runs, the item editor is locked, and the update compares the folder's copy once more right before replacing it. An editor whose draft is untouched follows its saved item when that changes, so a panel opened mid-update shows the updated skill and stays clean. Renaming a tracked skill keeps its source record and last check under the new name; removing it drops them.

Settings, Canonfig version shows the running version and `canonfig self-update` for both roles. Updates stay off until the person names npm's `npm-cli.js` and confirms nothing else of Canonfig's runs; an interrupted sync refuses that, as the CLI does. Check asks for the newest patch in the current major.minor line, and turning updates off drops the answer of a check still running; a running source service, sync or other Canonfig command refuses turning updates off. Installing a patch is CLI-only for now: when one is available, the page shows `canonfig self-update apply --apply` to run in a terminal, and the machine menu names the patch. Why the GUI does not apply updates itself is in [ADR 0001](../docs/adr/0001-local-browser-gui.md#self-update-from-the-gui).

Dialogs opened from state rather than a trigger (`useDialogReturnFocus` in `src/workspace/kit.tsx`, including every `ConfirmDialog`) return focus to the button that opened them on Cancel or Escape, and to the page heading or the next control when that button is gone or disabled.

Leaving any form with an unsaved draft asks before discarding it: the item editor, Profile defaults, new group, Agent policy, Source secret, Follower schedule and the local item editor. This covers closing a panel, choosing another row, in-app navigation and Demo panel role changes, but not browser Back/Forward or reload. Each form's own Save, Cancel, Discard or remove never asks.

Detail panels fill the screen below 768px, focus their close button on opening and trap Tab/Shift+Tab while the page behind is inert. Narrow screens start with the list, not an automatically opened panel; selecting a row or following an explicit `?focus` link opens details. Desktop panels remain non-modal beside the list, with default selection retained in Sync. Closing a panel restores its opener when available. The desktop resize edge takes keyboard focus: arrow keys resize in 16px steps, and Home/End jump to the minimum and maximum width. Machine map links are reachable with Tab and show the same explanation on focus as on hover; Escape hides it.

The first Tab stop on a fresh workspace page is "Skip to content", visible only when focused; Enter focuses the main content. Page navigation moves focus to the destination heading, unless an opened detail panel already owns focus. Publish, profile and machine dialogs return focus to their opener on dismissal; publishing or confirming Remove/Revoke focuses the page heading when the opener disappears.

The command palette opens and closes instantly. Map zoom, fit and reset are instant for keyboard activation and reduced motion; pointer controls otherwise retain short transitions. State bands animate gently while idle and move faster during work; reduced motion keeps them static. Dynamic counters use Ioskeley Mono so digit widths stay stable.

First-run setup gets more motion than daily screens, because people see it once. The background keeps drifting behind every screen of setup, pinned to the window, so a step that grows never resizes it. On the first visit the role choice arrives as a group out of a slight blur, with the heading, cards and footnote rising in one after another; hovering a card with a mouse brightens its border, and pressing it sinks it a little. The picked card's frame then grows into the wizard card while the other card drops away, and the wizard's parts rise in as it lands; "Change my answer" shrinks the card back into its place. Wizard steps slide in the direction of travel (Continue from the right, Back from the left) with their items rising in a short stagger, the card's height and the stepper's ring move with them, and focus moves to the new step's heading. A newly completed step draws its check, errors drop into place, and pressing Continue again while errors show shakes them once. While setup creates the Source or joins it, the background's rings close in on the card in step with the progress bar, each finished step sends one lit ring outward, and success settles them into slow green rings. Finishing grows the stepper's ring into the success badge, draws its check and sends one green dither sweep across the card. Reduced motion keeps only fades and a still background, with one still frame each for idle, running and done.

Fonts: Manrope (variable weight, OFL) for UI text and Ioskeley Mono 2.2.0 (OFL) for code, both self-hosted in `public/fonts` with their licence files.

Icons use [Solar](https://github.com/480-Design/Solar-Icon-Set) by 480 Design, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), including toast notifications. `scripts/build-icons.py` generates `src/components/icons.tsx` from the pinned `@iconify-json/solar` devDependency, so the bundle carries only the glyphs the app names and nothing loads at runtime; to add an icon, add a name to its `ICONS` map and run `python3 scripts/build-icons.py` from `ui/`. Sidebar icons use 16px boxes aligned with labels at a 40px inset. Linear outlines are the default; the Bold variant (`bold` prop) marks selection or status. Machine platforms show as text because Solar has no brand logos. Group help appears on hover or keyboard focus and stays visible on touch devices. Linear's custom icons are not used.

