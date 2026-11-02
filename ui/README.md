# Canonfig UI

The browser frontend lives in `ui/`. Workspace screens are in `src/workspace/`, shared components and demo data in `src/shared/`, and first-run setup in `src/onboarding/`. See [the architecture decision](../docs/adr/0001-local-browser-gui.md).

Machine operations still use simulated data. The Demo switcher selects a Source, Follower or new machine; it does not connect to a real machine. CLI serving and backend integration are not implemented yet, so this frontend is not included in the published CLI package.

Run from the repository root:

```bash
npm --prefix ui ci
npm run ui:dev
```

Open `http://localhost:5317/source/overview`. The independent frontend lockfile stays in `ui/package-lock.json`. Root scripts `ui:typecheck`, `ui:lint` and `ui:build` delegate to this package. The frontend build writes `ui/dist/`; production CLI packaging remains separate.

## Browser routes

The URL selects the role, screen and view tab. Links can be opened directly or refreshed, and browser Back/Forward follows navigation. `/` opens `/source/overview`; unknown or role-invalid paths show a not-found page.

| Screen | Source | Follower |
| --- | --- | --- |
| Overview | `/source/overview` | `/follower/overview` |
| Profile items | `/source/profile` | |
| Profile groups | `/source/profile/groups` | |
| Profile defaults | `/source/profile/defaults` | |
| Machine map | `/source/machines` | `/follower/machines` |
| Machine list | `/source/machines/list` | `/follower/machines/list` |
| Revisions | `/source/revisions` | |
| Secrets | `/source/secrets` | `/follower/secrets` |
| Sync | | `/follower/sync` |
| Schedule | | `/follower/schedule` |
| Local settings | | `/follower/local-settings` |
| Service | `/source/settings/service` | |
| Agent policy | `/source/settings/agent` | `/follower/settings/agent` |
| Harness projects | `/source/settings/harness` | `/follower/settings/harness` |
| Installers | `/source/settings/installers` | |
| Machine setup | `/source/settings/setup` | |
| Health check | `/source/settings/health` | `/follower/settings/health` |
| SSH tunnel | | `/follower/settings/tunnel` |
| Enrollment | | `/follower/settings/enrollment` |

First-run setup is `/setup`. Retired role and variant query parameters are not routing aliases.

## Guidance and presentation

Guidance lives in `src/workspace/guide.tsx`, with the spotlight component in `src/tour/`. It has three parts, remembered per role in localStorage: a four-stop tour offered on the first visit, a Get started list on Overview, and one tip on the first visit to a complex page. Take the tour, in the sidebar or the command palette, opens a picker with that short tour and one chapter of three to five stops per area (`src/workspace/tour-steps.tsx`). Selecting a chapter previews its steps and the pages it visits, numbered in order on a copy of the sidebar, so each chapter's `pages` list must match where its steps go. Finished chapters get a tick, can run again, and end with a button to the next chapter. Append `?tour=1` to start the short tour; reopen a page tip from its "?" button.

The machine map in `src/shared/machine-map/` also runs alone at `/map-demo.html?role=source|follower`, with `&publishing=1`, `&syncing=<follower ids>` and `&customize=<id>`. This separate component demo and `/break.html` are development-only entrypoints, not application routes.

The spotlight uses separate blur panels and a rounded dimming cutout. The card, cutout and blur switch targets together without a trailing animation. Tour and map controls have 40px minimum hit targets, increasing to 44px for coarse pointers. Map customization lives in the selected machine's unscaled toolbar.

Initial map fitting and Fit to screen never shrink nodes below their natural size, keeping node text at least 11px at narrow widths. Pan to reach the remaining machines, or zoom out manually. Keyboard focus and selection pan the node and its Open/Customize toolbar into view without changing zoom; hovering does not pan. Reduced motion makes these pans instant.

Single-step tips open from the page's "?" button without dimming or blurring the app. A tip never covers an open detail panel or the header actions (elements marked `data-tip-avoid`); it prefers a spot below the "?" that also clears the page's controls, such as the empty area under a list, and otherwise sits as close to the "?" as those regions allow. When no spot is free, as with a full-screen detail panel on a phone, the first-visit tip waits until the panel closes; the "?" still opens it on demand. Their heading sits beside the close button; only multi-step tours reserve a separate progress row. Tour and tip buttons draw at 28px, with invisible hit areas extending to 40px or 44px for coarse pointers.

Interface text sizing stays separate from the browser's root font size, so text sizing does not shrink the spacing scale. Desktop uses a 244px sidebar, 44px page headers, 28px view pills and 44px interactive list rows with a 36px inner highlight. Group headers remain 36px. Page titles use 15px/600 at a consistent 18px header inset; parent context follows the title on desktop. Below 768px, the title and help button occupy the first row, with page actions in a separate wrapping row when present.

Settings and form columns share an 880px maximum width and left alignment. Blocks within one column share its edges: Overview's Get started list and item-by-machine table sit in the main column and end where its lists do, and intros, notices and the Sync band above a list keep their text at the list's 18px inset. Profile, Sync, local-settings, secrets and settings lists cap their name/item columns at 240px and path/target columns at 360px where applicable; the final column takes spare space. Narrow lists retain horizontal scrolling rather than compressing their columns.

Use `variant="primary"` for at most one gold commit/create action per view. Default and secondary buttons are neutral; outline buttons are for toolbar and row actions, ghost buttons for unobtrusive controls, and destructive buttons use red text and a faint red tint. Disabled buttons use dashed borders, muted text and a not-allowed cursor, with no hover or press treatment. Green is not a button fill.

Below 768px, a navigation sheet replaces the sidebar. It traps focus and closes on Escape or any navigation link, including the current page. The desktop sidebar scrolls independently in short windows. Its Demo switcher stays in the sidebar flow; mobile workspace screens keep it inside the navigation sheet. Setup and not-found pages use a compact 44px Demo disclosure button in the header on mobile and keep the full switcher at the bottom-left on desktop.

Profile settings edits include unfinished key rows: adding a blank key enables Save and Discard. Save reports empty or duplicate key names without changing the saved item, focuses the first invalid field, and associates each key error with its input. Discard restores the saved fields and key rows.

Leaving any form with an unsaved draft asks before discarding it: the item editor, Profile defaults, new group, Agent policy, new harness project, Source secret, Follower schedule, local settings and profile choice. This covers closing a panel, choosing another row, in-app navigation and Demo switcher changes, but not browser Back/Forward or reload. Each form's own Save, Cancel or remove never asks.

Detail panels fill the screen below 768px, focus their close button on opening and trap Tab/Shift+Tab while the page behind is inert. Narrow screens start with the list, not an automatically opened panel; selecting a row or following an explicit `?focus` link opens details. Desktop panels remain non-modal beside the list, with default selection retained in Sync and Harness. Closing a panel restores its opener when available. The desktop resize edge takes keyboard focus: arrow keys resize in 16px steps, and Home/End jump to the minimum and maximum width. Machine map links are reachable with Tab and show the same explanation on focus as on hover; Escape hides it.

The first Tab stop on a fresh workspace page is "Skip to content", visible only when focused; Enter focuses the main content. Page navigation moves focus to the destination heading, unless an opened detail panel already owns focus. Publish, profile and machine dialogs return focus to their opener on dismissal; publishing or confirming Remove/Revoke focuses the page heading when the opener disappears.

The command palette opens and closes instantly. Map zoom, fit and reset are instant for keyboard activation and reduced motion; pointer controls otherwise retain short transitions. State bands animate gently while idle and move faster during work; reduced motion keeps them static. Dynamic counters use Ioskeley Mono so digit widths stay stable.

First-run setup gets more motion than daily screens, because people see it once. The background keeps drifting behind every screen of setup, pinned to the window, so a step that grows never resizes it. On the first visit the role choice arrives as a group out of a slight blur, with the heading, cards and footnote rising in one after another; hovering a card with a mouse brightens its border, and pressing it sinks it a little. The picked card's frame then grows into the wizard card while the other card drops away, and the wizard's parts rise in as it lands; "Change my answer" shrinks the card back into its place. Wizard steps slide in the direction of travel (Continue from the right, Back from the left) with their items rising in a short stagger, the card's height and the stepper's ring move with them, and focus moves to the new step's heading. A newly completed step draws its check, errors drop into place, and pressing Continue again while errors show shakes them once. While setup creates the Source or joins it, the background's rings close in on the card in step with the progress bar, each finished step sends one lit ring outward, and success settles them into slow green rings. Finishing grows the stepper's ring into the success badge, draws its check and sends one green dither sweep across the card. Reduced motion keeps only fades and a still background, with one still frame each for idle, running and done.

Fonts: Manrope (variable weight, OFL) for UI text and Ioskeley Mono 2.2.0 (OFL) for code, both self-hosted in `public/fonts` with their licence files.

Icons use [Solar](https://github.com/480-Design/Solar-Icon-Set) by 480 Design, licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), including toast notifications. `scripts/build-icons.py` generates `src/components/icons.tsx` from the pinned `@iconify-json/solar` devDependency, so the bundle carries only the glyphs the app names and nothing loads at runtime; to add an icon, add a name to its `ICONS` map and run `python3 scripts/build-icons.py` from `ui/`. Sidebar icons use 16px boxes aligned with labels at a 40px inset. Linear outlines are the default; the Bold variant (`bold` prop) marks selection or status. Machine platforms show as text because Solar has no brand logos. Group help appears on hover or keyboard focus and stays visible on touch devices. Linear's custom icons are not used.

