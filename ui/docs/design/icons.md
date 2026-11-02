# Icons

Solar by 480 Design (CC BY 4.0), and nothing else. Phosphor, Lucide and Linear's custom icons are not used. Import every icon from `@/components/icons`:

```tsx
import { Key, WarningCircle } from "@/components/icons";
```

`src/components/icons.tsx` is generated. Never edit it and never paste an SVG into a screen. To add an icon, add `"ComponentName": "solar-name"` to the `ICONS` map in `scripts/build-icons.py` (name without the `-linear`/`-bold` suffix) and run `python3 scripts/build-icons.py` from `ui/`. The bundle then carries only the glyphs the app names, and nothing loads at runtime.

First reuse an existing export: the 60-odd names in `icons.tsx` cover navigation, state and actions. A new one must name a real Solar glyph: look it up at https://icon-sets.iconify.design/solar/ or in `node_modules/@iconify-json/solar/icons.json`. The script stops with "Solar has no …" when the `-linear` or `-bold` glyph is missing, so a guessed name never ships. Name the export by its meaning at the call site (`Plug` for the SSH tunnel), not by the Solar file name.

Solar has no brand logos, so machine platforms (macOS, Linux) show as text.

## Linear and Bold

Every icon has two looks. Linear (outline) is the default. Pass `bold` only to mark selection or status:

- the selected sidebar entry;
- toast icons (`CheckCircle`, `Warning`, `XCircle`, `Info` in `sonner.tsx`);
- a status glyph that stands alone, like the star prompt's `Star bold`.

```tsx
// Correct: the toast's success icon
<CheckCircle bold className="size-4 text-ok" />

// Incorrect: bold for emphasis on a plain action
<Button size="sm"><Plus bold /> Add item</Button>
```

## Size and colour

Icons are `1em` by default and follow `currentColor`. Size with `size-*` classes only:

| Where | Size |
| --- | --- |
| Inside a `Button` | none: the button sizes it (`size-3` at `xs`, `size-3.5` at `sm`, `size-4` otherwise) |
| Beside 13px row text, field errors, `Hint` | `size-3.5` (14px) |
| Panel titles, toasts, sidebar entries | `size-4` (16px) |
| Setup choice rows (`RadioRow`) | `size-5` (20px) |

Quiet icons beside a name are `text-faint` (a key before a secret name) or `text-muted-foreground` (resource kind icons). An icon takes a state colour only when it reports that state.

Resource kinds always use `KIND_ICON` (`kit.tsx`): file `FileText`, directory `Folder`, config `SlidersHorizontal`, skill `Sparkle`, tool `Wrench`, credential `Key`. Never pick a different icon for a kind.

## Accessibility

Icons render `aria-hidden` unless given `aria-label`. An icon-only button carries `aria-label` on the button and a `Tooltip` with the same words (see [buttons](buttons.md)). A bare decorative icon never gets a label.
