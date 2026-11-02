# Overlays

All overlays come from `src/components/ui/` and already carry the popover surface, the hairline ring, the motion timings and focus handling. Screens set width and content only.

```
What needs to float?
 ├── A name or explanation on hover/focus, no interaction inside → Tooltip (Hint, Term, StateLabel wrap it)
 ├── A short list of actions for one row or machine → DropdownMenu
 ├── A small editor anchored to a control (time picker, colour picker) → Popover
 ├── One record to view or edit beside the list → DetailPanel (not an overlay; see lists.md)
 ├── A short task that ends in one commit, or a confirmation → Dialog
 └── Navigation or a full-height side surface on phones → Sheet
```

## Dialog

Use for a focused task that ends in one commit (Set a shared secret, Publish revision, Invite a machine) and for every confirmation. Use a `DetailPanel` instead when the person needs the list beside it, and a toast instead when nothing needs an answer.

- Width: `className="grid-cols-[minmax(0,1fr)] sm:max-w-md"` for confirmations and short forms. Wider dialogs (invitations, the tour picker) set their own `sm:max-w-*`.
- Structure: `DialogHeader` with `DialogTitle` and a `DialogDescription className="text-base text-pretty"`, the fields, then `DialogFooter`.
- A form dialog wraps its content in `<form className="contents" onSubmit>` so Enter submits, and the primary is `type="submit"`.
- `showCloseButton` defaults to `true` (the X). `animated={false}` drops the zoom; only the command palette uses it, because the palette opens instantly.
- Focus returns to the opener on close. When the opener disappears (after Remove), move focus to the page heading.

```tsx
// Correct (source.tsx, Set a shared secret, trimmed)
<DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-md">
  <form className="contents" onSubmit={save}>
    <DialogHeader>
      <DialogTitle>Set a shared secret</DialogTitle>
      <DialogDescription className="text-base text-pretty">Machines that can receive secrets get it on their next update.</DialogDescription>
    </DialogHeader>
    <div className="grid gap-3">…Field…</div>
    <DialogFooter>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      <Button type="submit" variant="primary">Save secret</Button>
    </DialogFooter>
  </form>
</DialogContent>

// Incorrect: a hand-made modal, and the primary as a plain onClick outside a form
<div className="fixed inset-0 bg-black/60"><div className="rounded bg-zinc-900 p-6">…<Button onClick={save}>OK</Button></div></div>
```

## ConfirmDialog

The confirmation for every destructive action (`settings.tsx`). Props: `title` as a question, `body` that says what is lost and what stays, `confirm` that repeats the action, `onConfirm`.

```tsx
// Correct (follower.tsx UnenrollDialog)
<ConfirmDialog
  open={ws.unenrollOpen}
  onOpenChange={ws.setUnenrollOpen}
  title={`Stop syncing ${ws.machineName}?`}
  body="This machine stops getting revisions, … Joining again needs a new invitation from atlas."
  confirm={PLAIN.unenroll}
  onConfirm={() => ws.unenroll()}
/>

// Incorrect: a vague question and a generic button
<ConfirmDialog title="Are you sure?" body="This cannot be undone." confirm="OK" … />
```

The discard-draft confirmation is `useLeaveGuard`'s own dialog; never build a second one.

## DropdownMenu

For two or more actions on one row or machine, behind a `ghost` `icon-xs` button with `DotsThree` and an `aria-label` naming the target ("Actions for anthropic-api-key"). `DropdownMenuContent align="end"`. Items are verbs; an item that opens a dialog ends with `…`. Destructive items go last, after a `DropdownMenuSeparator`, with `variant="destructive"`. A single action is a button, not a menu.

```tsx
// Correct (source.tsx SecretsView row)
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <Button variant="ghost" size="icon-xs" className="justify-self-end" aria-label={`Actions for ${s.name}`}><DotsThree /></Button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuItem onSelect={() => openSet(s.name)}>Replace value…</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(s.name)}>Remove…</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>

// Incorrect: a destructive item that acts at once, first in the list
<DropdownMenuItem variant="destructive" onSelect={() => remove(s.name)}>Remove</DropdownMenuItem>
```

## Popover

For an editor anchored to its control: the schedule time list (`schedule.tsx`), the map's accent picker. Never put a form with its own Save in a popover; that is a dialog.

## Tooltip

200ms in, after the provider's 250ms delay (`App.tsx`). Contents: a few words naming the control, or one or two sentences explaining a term (`max-w-64 text-sm`). Never put a link, button or anything focusable inside. Information a person needs to act goes on the page, not in a tooltip. Use the wrappers first:

- `Hint`: a "?" after a label that explains it. Its `label` prop names what it explains for screen readers.
- `Term`: a glossary word with a dotted underline.
- `StateLabel`: a state with its explanation.

```tsx
// Correct (machines.tsx)
Identity <Hint label="Identity">This machine's own revocable identity, given when it joined. Revoking it cuts off this machine only.</Hint>

// Incorrect: a raw title attribute, invisible to keyboard and touch
<span title="This machine's own revocable identity">Identity</span>
```

## Sheet

Two uses only: the navigation sheet below 768px (`workspace.tsx`, `side="left"`) and setup's glossary (`onboarding/kit.tsx`, `side="right"`). `side` also accepts `top` and `bottom`; neither is used. Never open a record in a sheet; the `DetailPanel` already covers the content on phones.

## Command palette

`CommandDialog` in `frame.tsx`, opened with Cmd/Ctrl K. It lists role actions and "Go to" entries built from `nav.ts`. A new page appears there by being in `nav.ts`; add a palette action only for a task people start from anywhere.
