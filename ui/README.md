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

Guidance lives in `src/workspace/guide.tsx`, with the spotlight component in `src/tour/`. It has three parts, remembered per role in localStorage: a four-stop tour offered on the first visit, a Get started list on Overview, and one tip on the first visit to a complex page. Reopen the tour from the sidebar or command palette, or append `?tour=1`; reopen a page tip from its "?" button.

The machine map in `src/shared/machine-map/` also runs alone at `/map-demo.html?role=source|follower`, with `&publishing=1`, `&syncing=<follower ids>` and `&customize=<id>`. This separate component demo and `/break.html` are development-only entrypoints, not application routes.

The spotlight uses separate blur panels and a rounded dimming cutout. The card, cutout and blur switch targets together without a trailing animation. Tour and map controls have 40px minimum hit targets, increasing to 44px for coarse pointers. Map customization lives in the selected machine's unscaled toolbar.
Single-step tips open beside the page's "?" button without dimming or blurring the app. Their heading sits beside the close button; only multi-step tours reserve a separate progress row. Tour and tip buttons draw at 28px, with invisible hit areas extending to 40px or 44px for coarse pointers.

The desktop layout keeps interface text separate from the browser's root font size, so text sizing does not shrink the spacing scale. It uses a 244px sidebar, 44px page headers, 28px view pills and 44px interactive list rows with a 36px inner highlight. Group headers remain 36px. Headers and rows share their column inset; scalar settings use grouped cards with separators. Profile columns keep related values together on wide displays. Narrow lists retain horizontal scrolling, but the fixed sidebar is not a phone layout.

The sidebar scrolls independently in short windows. Its Demo switcher stays in the sidebar flow, so it cannot cover settings links. Setup and not-found pages keep the switcher in the bottom-left corner.

Profile settings edits include unfinished key rows: adding a blank key enables Save and Discard. Save reports empty or duplicate key names without changing the saved item, focuses the first invalid field, and associates each key error with its input. Discard restores the saved fields and key rows.

Leaving an item editor with unsaved edits asks before discarding them; this covers closing it, choosing another row and in-app navigation, but not browser Back/Forward or reload.

Detail panels return focus to whatever opened them when they close. Their resize edge takes keyboard focus: arrow keys resize in 16px steps, and Home/End jump to the minimum and maximum width. Machine map links are reachable with Tab and show the same explanation on focus as on hover; Escape hides it.

The command palette opens and closes instantly. Map zoom, fit and reset are instant for keyboard activation and reduced motion; pointer controls otherwise retain short transitions. State bands animate gently while idle and move faster during work; reduced motion keeps them static. Dynamic counters use Ioskeley Mono so digit widths stay stable.

Fonts: Open Runde 1.0.1 (rounded Inter, OFL) for UI text and Ioskeley Mono 2.2.0 (OFL) for code, both self-hosted in `public/fonts` from their official releases with their licence files.

Icons use [Phosphor](https://phosphoricons.com) (MIT), including toast notifications. Sidebar icons use 16px boxes aligned with labels at a 40px inset. Regular outlines are the default; filled variants mark selection or status, and bold checks stay legible at small sizes. Group help appears on hover or keyboard focus and stays visible on touch devices. Linear's custom icons are not used.

