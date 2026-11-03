# Colours

All colours are semantic tokens in `src/index.css` (`:root` values, exposed as Tailwind colours in `@theme inline`). Dark only: there is no light theme and no `dark:` work to do in screens. Use the utility, never the value (see the token rule in `DESIGN.md`).

## Surfaces

| Token | Use |
| --- | --- |
| `canvas` | The app backdrop behind the inset panel (`body`); inset wells for command text at `/60` |
| `sidebar` | The sidebar column only |
| `panel` | The content panel and anything that must cover it while scrolling (sticky `ListHead`) |
| `background` | Dither paper, the fade over `StateBand`; form controls sit on it through the primitives |
| `raised` | Selected row fill, active `ToolbarTab`, hovered row at `/50`, `settingsGroup` card at `/40` |
| `secondary` | Neutral control fill: `default`/`secondary` buttons, code chips at `/70` |
| `muted` | Tracks and skeleton bars (`DitherProgress` track) |
| `popover` | Dialogs, sheets, menus, selects, tooltips, toasts. The primitives set it; screens never do |

`card`, `portal` and `accent` exist in `index.css` but no screen uses them (`accent` only colours menu and select item focus inside the primitives). Do not start using them.

```
What background does this element need?
 ├── Floating above the page (dialog, menu, tooltip, toast) → use the primitive; it is bg-popover
 ├── A row or pill that is selected or active → bg-raised
 │    └── only hovered → hover:bg-raised/50 (ListRow does this for you)
 ├── A card of settings rows → className={settingsGroup}
 ├── A command or code block → bg-canvas/60 with border-border (CommandBox)
 ├── A progress track or placeholder → bg-muted
 └── Anything else → no background; the panel shows through
```

## Text

| Token | Use |
| --- | --- |
| `text-foreground` | Titles, row names, values, anything the person reads first |
| `text-muted-foreground` | Descriptions, field labels, secondary values, `Lede` |
| `text-faint` | Column heads, counts, placeholders, timestamps, disabled text, quiet icons |

Three tiers, nothing below `text-faint`: it is the lowest tier that still clears 4.4:1 on the panel (comment in `index.css`). Never dim text with `opacity-*`; the one exception is an inert section that a mode switch disables (`opacity-40` with `inert`, Agent policy).

```
What text colour?
 ├── The name or value this row or field is about → text-foreground
 ├── Explains or labels it → text-muted-foreground
 ├── Metadata, counts, hints at rest → text-faint
 └── Reports machine state → the state token (below), always with a label
```

## Borders

`border-border` is the default hairline (set on `*`, so a bare `border` already uses it). `border-border-strong` is for emphasis on hover, tooltips and the dashed disabled button. `divide-border/70` separates rows inside `settingsGroup` and `StatusRow`. Inputs use `border-input` through the primitive. There are no other border colours.

## State colours

| Token | Meaning | Status kind |
| --- | --- | --- |
| `ok` | Up to date, done, connected, added | `ok` |
| `warn` | Edited on a machine, modified since the last revision, an update ready to apply | `warn` |
| `act` | Needs a person: "Needs you", a sign-in only a person can do | `act` |
| `bad` | Failed, unreachable, invalid, destructive (`destructive` aliases `bad`) | `bad`, `offline` |
| `text-faint` | Off, not used, not applied, excluded | `off` |

Use them through components first: `StatusMark`, `StateLabel`, `ChangeMark`, `Attention` (`follower.tsx`), `Field` errors, toasts. Write `text-ok` by hand only for a check icon that confirms an action (`Check className="text-ok"` after a copy).

Tints are `bg-<state>/12` to `/15` behind `text-<state>` (ChangeMark, Stepper). Never fill a large area or a button with a state colour.

## Gold and violet

- `gold` / `gold-hover` / `gold-foreground`: the `primary` button. The only other use is the highlight for tools that setup proposed (`bg-gold/8` notice and `bg-gold/15` tag in `profile.tsx`). `warn` has the same hue, so never put gold next to a status.
- `ring`: focus rings (`focus-visible:ring-2 focus-visible:ring-ring/60`, or the global `:focus-visible` outline) and the info toast.
- `dither-purple`: tour and guidance art (tour offer, chapter marks, route lines in `guide.tsx`). Guidance uses violet so it never competes with the page's gold action.

```tsx
// Correct: state through the component, label beside it
<StatusMark kind={up ? "ok" : "offline"} />
{up ? "Connected just now" : "Stopped"}

// Incorrect: a raw colour and a colour-only status
<span className="size-2 rounded-full bg-[#7aae7a]" />
```

## Dither colours

`dither-blue`, `dither-purple`, `dither-green`, `dither-pink`, `dither-orange`, `dither-red`, `dither-grey` exist for dithered art and the machine map's accent picker. Screens reach them through `tone` props (`DitherBlock`, `StateBand`, `DitherProgress`), not by class. See [dither](dither.md).
