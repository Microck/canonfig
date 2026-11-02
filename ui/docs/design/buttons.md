# Buttons and actions

## Button

Use `Button` (`@/components/ui/button`) for every action. Navigation is not a button: pages are sidebar entries, view pills are `ToolbarTab`, and a row that opens something is a `ListRow` or `StatusRow` with `onClick`. The one exception is a lone way out of a dead end (the not-found page's `<Button asChild size="lg"><a href=…>`). Two or more row actions go in a `DropdownMenu` behind a `DotsThree` icon button.

Variants: `primary`, `secondary`, `outline`, `ghost`, `destructive`. These five are the system. The union also contains `default` (renders exactly like `secondary`, and is what you get when `variant` is omitted) and `link` (no screen uses it). Write `secondary` rather than relying on `default`; never use `link` for a standalone action. Any other variant is a bug.

- `primary`: gold fill. The single commit or create action of the view: Save, Add, Publish, Start. At most one visible at a time.
- `destructive`: red text on a faint red tint. Every irreversible action (Stop syncing, Remove, Abandon) and the confirm button of its dialog.
- `outline`: toolbar, header and row actions that are not the primary one (Discover tools, Stop tunnel, Resume).
- `ghost`: Cancel, Discard, Keep editing, and every icon-only button.
- `secondary`: any other standalone action, typically inside a panel footer or a card ("Add a machine…", "Take the tour").

Never restyle a button's fill, text colour or border with `className`. Layout classes (`ml-auto`, `w-full`, `justify-self-start`) are fine. Green is never a button fill.

```
Which variant?
 ├── Does it commit or create the thing this view is about?
 │    ├── Is another primary already visible (open panel, dialog)? → outline
 │    └── No → primary
 ├── Is it destructive or hard to undo? → destructive (and confirm it, below)
 ├── Is it icon-only, or does it back out (Cancel, Discard, Keep editing)? → ghost
 ├── Is it in the page header, a toolbar or a list row? → outline
 └── Otherwise → secondary
```

One primary per view is enforced by hand. When a detail panel or tab brings its own primary, the header demotes its own to `outline` (`profile.tsx`):

```tsx
// Correct: Publish is gold only while no item panel (with its own gold Save) is open
<Button size="sm" variant={detail || tab === "defaults" ? "outline" : "primary"} onClick={() => ws.setPublishOpen(true)}>
  Publish revision <AnimatedNumber value={ws.nextSequence} />
</Button>

// Incorrect: a second gold button beside the panel's Save
<Button size="sm" variant="primary" onClick={() => ws.setPublishOpen(true)}>Publish revision</Button>
```

A toggle's variant follows its state: the action that restores normal service is primary, the one that stops it is outline (`variant={up ? "outline" : "primary"}` on Start/Stop tunnel).

### Sizes

Sizes: `sm`, `default`, `xs`, `lg`, `icon-sm`, `icon-xs`, `icon`. `icon-lg` exists and is unused.

| Where | Size |
| --- | --- |
| Page header actions, panel footers, toolbars, inline actions in content | `sm` (28px) |
| Dialog footers | omit `size` (`default`, 32px) |
| Header and panel close, the page "?" | `icon-sm` (28px circle) |
| Icon actions inside rows, chips and command boxes | `icon-xs` (24px) |
| The phone navigation's open and close | `icon`, enlarged to `size-10`/`size-11` for touch |
| The tour picker's Start, the not-found page's way home | `lg` (36px) |

`xs` (24px) is for text actions inside an Overview list row or an `Attention` notice: `outline` for Open, Recover or Review, `destructive` for Abandon.

### Order and placement

- Header actions: the primary is the last child, so it sits at the right edge, and wraps to its own row below 768px.
- Panel footers: destructive on the left; Discard or Cancel (`ghost`) then the primary inside `ml-auto`.
- Dialog footers: `ghost` Cancel first, then the primary or destructive action. A dialog that only shows steps to follow closes with a `secondary` Done.

### States

- Disabled: every variant draws a dashed strong border, faint text and a not-allowed cursor, with no hover or press. Disable a commit button until the draft differs from the saved value (`disabled={!dirty}`).
- Busy: keep the button, disable it and change the label to the running verb with an ellipsis: `"Updating…"`, `"Starting…"`. Never swap in a spinner.
- A label that opens a dialog or menu step ends with `…`: "Remove…", "Add a machine…".

## Icon-only buttons

Use `variant="ghost"` with `size="icon-sm"` or `"icon-xs"`. Give the button an `aria-label` that names its target ("Actions for anthropic-api-key", "Remove key 2"), and wrap it in a `Tooltip` with the same words when the icon alone is ambiguous.

```tsx
// Correct (kit.tsx PageHeader)
<Tooltip>
  <TooltipTrigger asChild>
    <Button variant="ghost" size="icon-sm" className="text-faint" aria-label="How this page works" onClick={() => ws.openTip(ws.view)}>
      <Question />
    </Button>
  </TooltipTrigger>
  <TooltipContent>How this page works</TooltipContent>
</Tooltip>

// Incorrect: no name, so a screen reader hears "button"
<Button variant="ghost" size="icon-sm"><X /></Button>
```

## Menu actions

`DropdownMenuItem` has `variant` `default` and `destructive`, nothing else. Put destructive items last, after a `DropdownMenuSeparator`. A destructive item opens a confirmation; it never acts directly.

## Confirming

Every destructive action is confirmed with `ConfirmDialog` (`settings.tsx`): a title that asks the question ("Stop syncing atlas-mini?"), a body that says what is lost, `ghost` Cancel and a `destructive` button whose label repeats the action. Stops that are easy to reverse (Stop tunnel) are not confirmed. See [overlays](overlays.md).
