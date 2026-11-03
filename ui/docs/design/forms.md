# Forms and settings

## Pick the layout

```
Where does the form live?
 ├── A settings page (one thing's scalar settings) → SettingRow rows in a settingsGroup card, inside Column
 ├── A DetailPanel or Dialog → Field (label above control) in a grid gap-3 / gap-4
 └── First-run setup → onboarding/kit.tsx Field and RadioRow (taller 40/44px controls)
```

Never import the workspace `Field` into onboarding or the onboarding `Field` into the workspace: they size controls differently.

## settingsGroup and SettingRow

`settingsGroup` (`kit.tsx`) is a class, not a component, so a `RadioGroup` or `<ol>` can be the card itself. `SettingRow` is one row: `title`, optional `description`, optional `error`, and the control or value on the right.

- Put a `SectionLabel` above each card and `mt-8` between groups.
- Inputs inside a row are 28px: `Input className="h-[28px] w-64 font-mono text-sm"` (width `w-20` for numbers, `w-40` for short values, `w-64` for paths and commands). A `SelectTrigger` keeps its default size with a fixed width (`className="w-40"`); `size="sm"` is for selects inside a panel form's compact rows (item editor).
- A row whose value is read-only shows the value as children (`<Mono className="text-foreground">`), no disabled input.
- On phones, stack row content: add `max-sm:[&>div]:flex-col max-sm:[&>div]:items-start max-sm:[&>div]:gap-2` to the card when its rows hold inputs (Agent policy).
- A mode that disables a whole group wraps it in `inert` with `opacity-40`, so it leaves the tab order.

```tsx
// Correct (settings.tsx AgentPolicyView)
<SectionLabel>Harness bounds</SectionLabel>
<div className={settingsGroup}>
  <SettingRow title="Command" htmlFor="ap-exec" description="Your agent's executable, by name or full path." error={executableError}>
    <Input id="ap-exec" value={executable} onChange={(e) => setExecutable(e.target.value)} aria-invalid={!!executableError}
      aria-describedby={executableError ? "ap-exec-note" : undefined} autoComplete="off" spellCheck={false} className="h-[28px] w-64 font-mono text-sm" />
  </SettingRow>
</div>

// Incorrect: a bordered card made by hand and a label with no htmlFor
<div className="rounded-lg border p-4"><span>Command</span><Input /></div>
```

## Field

A label above a control with an optional `description`, `hint` (a `Hint` "?", needs a string `label`) or `error`. The error replaces the description in place and gets `id="<htmlFor>-note"`. Inputs here keep the primitive's 32px height.

```tsx
// Correct (machines.tsx invitation dialog)
<Field label="Machine name" htmlFor="inv-name" description="Optional. Fills in the commands below; the machine can pick another name.">

// Incorrect: a bare label and an error in a toast instead of under the field
<label>Machine name</label><Input />{toast.error("Name is invalid")}
```

## Which control

```
What does the person choose?
 ├── Free text, a path, a name, a number → Input (font-mono for paths, names, ports)
 ├── A list of values added one at a time (paths, hosts) → the Writable paths pattern, below
 ├── A block of pasted text (an invitation) → Textarea
 ├── One of 2 to 4 options that each need a sentence → RadioGroup styled as a settingsGroup card
 ├── One of a known list, labels alone are clear → Select
 ├── Any number of items from a list → Checkbox per row
 └── One on/off choice → Switch in a labelled row, part of the draft like any field
```

`Select` opens below its trigger at the trigger's width (`position="popper"`); never set `position`. `SelectTrigger` `size` is `default` or `sm`. `Switch` has `size` `default` and `sm`; only `default` is used. Radio cards follow Agent policy: a `Label` per option with the `RadioGroupItem`, a 13px/500 title and a 12px muted body, `bg-raised/60` when chosen.

A list of values follows Writable paths (`settings.tsx`): a `Field` holding one 32px bordered row per value (`Mono` text, a `ghost` `icon-xs` X labelled "Remove <value>"), then a small `<form>` with a 28px mono `Input` and an `outline` `sm` "Add <thing>" button. Adding a value changes the draft; the page's Save still commits it. A list the person can't edit shows each value as a `rounded border px-2 py-0.5 font-mono text-xs` chip.

## Validation

1. Keep a draft in `useState`; compare it with the saved value for `dirty`. The saved value lives in `useSharedState` so it outlives the page.
2. The commit button (gold, in the header or panel footer) is disabled until `dirty`.
3. Show errors only after the first Save attempt (`tried`), or after a field's own Add button (`addTried`, Writable paths). On Save with errors, focus the first invalid field by id and stop.
4. Set `aria-invalid` and `aria-describedby="<id>-note"` on the control; pass the message to `Field` or `SettingRow` `error`.
5. Write the error as the fix: "Enter a path that starts with /, ~/ or ./." Never "Invalid input".
6. On success, save, then `toast.success` with the thing saved ("Agent policy saved"). Never toast a validation error.

## Unsaved drafts

Every form with a saveable draft calls `useLeaveGuard(dirty, "the <thing>")` and renders its `dialog`. In-app navigation, row changes, the Demo switcher and panel close then ask "Discard unsaved changes?". Exits that settle the draft themselves (Save, Cancel on a new record, Remove) navigate inside `leaveWithoutAsking`.

```tsx
// Correct (settings.tsx AgentPolicyView)
const { dialog: leaveDialog } = useLeaveGuard(hasChanges, "the agent policy");
…
{leaveDialog}

// Incorrect: a browser prompt, which skips in-app navigation and looks foreign
useEffect(() => { window.onbeforeunload = () => "Unsaved changes" }, []);
```

## Secrets and credentials

A credential the GUI shows or echoes is a credential leaked into screenshots, recordings and logs.

- A credential (password, token, API key, passphrase) gets its own `Input type="password"` with `autoComplete="off"` and `data-1p-ignore` (Set a shared secret, `source.tsx`). Never accept one inside a URL, command or free-text field; split it out.
- Never prefill, display or copy a stored credential. Lists show secret names and update times only; "Replace value…" starts from an empty field.
- Never pass a credential to `copy()`, a toast or `WithCode`: `copy()` repeats the copied text in its toast.
- Say where the value goes in the field's `description` ("Canonfig keeps it in the credential store, never in the folder.").
