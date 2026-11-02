# Pages

Every workspace page is a fragment of `PageHeader`, then `Body`, then any dialogs or the `useLeaveGuard` dialog. Nothing else sits at the top level.

```tsx
// Correct: a settings page (follower.tsx TunnelView, trimmed)
<>
  <PageHeader crumbs={["Settings", "SSH tunnel"]} actions={<Button size="sm" variant="primary" onClick={toggle}>Start tunnel</Button>} />
  <Body>
    <Column>
      <Lede>This machine reaches the <Term term="Source Machine">Source</Term> through an SSH tunnel…</Lede>
      <SectionLabel>Status</SectionLabel>
      <div className={cn("mt-1", settingsGroup)}>
        <SettingRow title="Host">maria@atlas.local</SettingRow>
      </div>
    </Column>
  </Body>
</>

// Incorrect: a hand-made header and a scrolling div instead of Body (no skeleton, no panel slot)
<div className="p-6"><h1 className="text-2xl font-bold">SSH tunnel</h1>…</div>
```

## PageHeader

The 44px bar at the top of the panel (`kit.tsx`). `crumbs` lists parents then the title: `["Settings", "SSH tunnel"]` shows "SSH tunnel" with "in Settings" after it on desktop. `actions` holds the view's buttons, primary last. Every page has one; never write your own `h1`. The "?" appears on its own when the page has a tip in `page-tips.ts`.

## Body

The scrolling main column plus the optional `detail` panel. It provides the loading skeleton and is a size container, so lay out with `@container` queries (`@3xl:`), not viewport breakpoints, inside it. Pass `reloading` only when an action fetches the page's data again.

## Column, Lede and SectionLabel

Which content wrapper?

```
What is the page's main content?
 ├── A list of records (rows, columns) → put ListHead/ListRow straight in Body, no Column (see lists.md)
 ├── Settings or a form → <Column> (880px cap, px-4 / sm:px-8, bottom room for the last row)
 └── Nothing yet → <EmptyState> straight in Body
```

- `Column` and `Lede` live in `settings.tsx`; Follower forms import them from there.
- `Lede` is the page's one-paragraph intro, 13px muted, capped at 70ch. One per page, first in `Column`. It says what the page controls and why, using `Term` for domain words.
- `SectionLabel` heads each group of settings (13px/500, muted, 28px tall, optional `action` on the right). Space groups with `mt-8`. Never use a bare `h2`.
- A one-line notice above a list (no `Column`) uses `border-b border-border px-[18px] py-3 text-sm text-muted-foreground` so its text starts on the list's 18px line (Follower Secrets).

## Toolbar and ToolbarTab

A second 44px bar under the header for switching views of one page (Profile items, groups and defaults; Machines map and list). `ToolbarTab` is a 28px round pill link with an optional animated `count`. Use it for views with their own URL. Never use the `Tabs` primitive: it has no call sites and does not match the pills.

```tsx
// Correct (machines.tsx): each view is a URL; the active icon goes bold
<Toolbar>
  <ToolbarTab active={map} href={workspaceHref(ws.role, "machines", { focus: selected })}>
    <TreeStructure bold={map} className="size-3.5" /> Map
  </ToolbarTab>
</Toolbar>

// Incorrect: client-only tabs that a link or Back can't reach
<Tabs><TabsList><TabsTrigger value="map">Map</TabsTrigger></TabsList></Tabs>
```

## StateHeader

The machine-state headline that opens Overview, with a `StateBand` behind it. Overview only; another page reports state with `StatusMark` rows or `Attention` notices.

## EmptyState

Use when a list or page has nothing in it: a `title` that states the fact, a `body` that says how to get something there, and an optional `action` button. It grows into the leftover height so its `DitherBlock` sits on the bottom edge. `tone` is `muted` (default) or `ok`; nothing else.

```tsx
// Correct (source.tsx)
<EmptyState title="No revisions yet" body="Each time you publish the profile, it becomes a numbered revision here that machines can apply." />

// Incorrect: a centred grey sentence with no next step
<p className="py-20 text-center text-faint">Nothing here.</p>
```

## Measurements

Desktop: 244px sidebar, 44px page header and toolbar, 28px view pills, 44px list rows with a 36px fill, 36px group bands, an 18px left text inset shared by header, toolbar and rows. Settings columns cap at 880px. Breakpoint for the phone layout: `md` (768px); below it the sidebar becomes a sheet, header actions take a second row and detail panels cover the content. See README "Guidance and presentation" for the full list.

## Adding a workspace page

1. Write the component where its role's pages live: `follower.tsx` for Follower-only pages, `source.tsx` for Source-only pages (Profile and Machines are big enough for their own files), `settings.tsx` for settings both roles have. Export it as `<Name>View`.
2. Add the view to the role's union in `store.tsx` (`SourceView` or `FollowerView`).
3. Give it a path in `routes.ts` (`SOURCE_PATHS` or `FOLLOWER_PATHS`; settings live under `settings/`) and a row in `routes.test.ts`.
4. Add a nav entry with a Solar icon in `nav.ts` (`*_NAV` for main pages, `*_SETTINGS` for settings). The sidebar, command palette "Go to" list and tour previews read it.
5. Map the view to its component in `workspace.tsx` (`SOURCE_SCREENS` or `FOLLOWER_SCREENS`).
6. Add a row to the routes table in `README.md`.
7. A page tip in `page-tips.ts` only if the page breaks a convention; plain lists and settings forms get none.
8. State that another page reads (Overview, Health check, sidebar status) goes in `useSharedState` with one key and one `initial` shared by every reader.
9. Machine operations are simulated until the local service exists (ADR 0001). Run a pretend operation through `ws.later(callback, ms)`, which a role switch cancels, and write its result to shared state, since the page may have unmounted.
