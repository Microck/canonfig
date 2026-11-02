# Lists and detail panels

Records (items, machines, revisions, secrets, steps) show as a dense list of 44px rows with a sticky column head. Settings show as `SettingRow`s in a `settingsGroup` card instead (see [forms](forms.md)). Never use a card grid for records. The one `<table>` is Overview's item-by-machine matrix of `StateCell`s (`source.tsx`), a two-axis grid no list can show.

```
How do these records show?
 ├── Scalar settings of one thing (host, schedule, limits) → settingsGroup + SettingRow
 ├── Facts about the machine on Overview that open their page → StatusRow
 ├── Something that needs the person's attention, with actions → Attention (follower.tsx)
 └── A collection the person scans, sorts by eye or opens → ListHead + ListRow
```

## ListHead and ListRow

Both take the same `cols` (a CSS grid template) and `minWidth` (the sum of column minimums, gaps of 12px and 20px of row padding), so the head and rows line up and a narrow page scrolls sideways instead of squeezing.

- Cap name columns at 240px and path or target columns at 360px; give the last column `1fr`.
- `ListRow` with `onClick` becomes a button with the hover, selected and focus fills. Without it, it is a static row. Never put a second click target over the whole row.
- `selected` draws the `raised` fill and sets `aria-current`. Selection lives in the URL (`ws.focus`, opened with `ws.go(view, id)`), so links and Back work.
- Give the head and its rows the same `data-tour` id when a tour chapter points at the list.
- End a list with `<div className="pb-16" />`, as Revisions and Secrets do.

```tsx
// Correct (source.tsx RevisionsView)
const cols = "72px minmax(200px,360px) 140px 110px minmax(120px,1fr)";
const colsMin = 72 + 200 + 140 + 110 + 120 + 4 * 12 + 20;
<ListHead cols={cols} minWidth={colsMin}>…</ListHead>
<ListRow cols={cols} minWidth={colsMin} selected={selected === String(r.sequence)} onClick={() => ws.go("revisions", String(r.sequence))}>…</ListRow>

// Incorrect: rules between rows and a hand-made hover
<div className="flex border-b py-2 hover:bg-white/5">…</div>
```

Cell text: the name in `text-base` (with `font-medium` or `font-mono`), everything else `text-sm text-muted-foreground`, times and counts `tabular-nums`. A leading icon is `size-3.5 shrink-0 text-faint`.

`GroupRow` is the 36px band that heads a group of rows inside one list (resources by kind), with an optional count and a `hint` that shows on hover.

Rows that come and go animate with `RowPresence` and `AnimatedRow` (see [motion](motion.md)).

## Chips and marks inside rows

- `GroupChips`: a machine's or item's groups. Shows two, then "+N" with a tooltip. Never list groups as comma text.
- `ChangeMark`: the A/M/D letter for an unpublished change. `change` is `added`, `modified` or `removed`; pass nothing to keep the slot empty so names stay aligned.
- `ActionTag` (`follower.tsx`): the Sync plan's action tags. Its set is fixed to the plan's actions.
- `StateLabel`: a follower state with its mark, label and explanation tooltip. Pass `compact` in tight cells (label becomes screen-reader only) and `self` on the Follower's own screens.

## DetailPanel

The right-side panel that opens from a row (`kit.tsx`). Pass it to `Body` as `detail`, keyed by the row id, so a row switch remounts it:

```tsx
// Correct (source.tsx RevisionsView)
<Body detail={current && <RevisionDetail key={current.sequence} revision={current} onClose={() => ws.go("revisions")} />}>

// Incorrect: a panel rendered inside the list column, unkeyed, with no close or loading
<Body>{list}{current && <aside className="w-96 border-l">…</aside>}</Body>
```

- `title` is the record's name; `subtitle` holds one short status (`ChangeMark`, "Latest" in `text-xs text-ok`).
- Body content: `Prop` lines (112px label column) inside `px-4 py-3`; further groups start with `border-t border-border px-4 pt-3` and a `SectionLabel`.
- `footer` holds the actions: destructive on the left, Discard and the primary on the right. A panel with a gold Save makes the page header's primary `outline` while it is open (see [buttons](buttons.md)).
- An editable panel wraps its fields in a `<form id>` and the footer's submit button uses `form="<id>"`, so Enter saves.
- It is 380px wide (440px from a 1600px viewport), resizable between 320 and 560px, and covers the content below 768px. Never set its width.

Use a `DetailPanel` to view or edit one record while the list stays visible. Use a `Dialog` instead for a short task that ends in one commit and doesn't need the list (Set a shared secret, Invite a machine).

## StatusRow

A row in Overview's "This machine" column: a `StatusMark`, a label and a value, opening the page that owns the fact (`onClick={() => ws.setView("tunnel")}`). Both roles use it. A row without a status keeps the mark's slot.
