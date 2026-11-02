# Canonfig GUI design system

The Canonfig GUI is a dark-only, dense admin tool in the spirit of Linear, painted in the Ender palette. Surfaces stay neutral; colour appears only to report machine state, gold marks the one action that commits, and violet marks focus and guidance. Texture comes from ordered dithering, never from illustrations, gradients or shadows.

Everything below is generated from the code in `src/`. When the docs and the code disagree, the code wins and the doc is a bug.

## The token rule

Style with the Tailwind utilities that `src/index.css` generates from semantic tokens: `bg-panel`, `bg-raised`, `text-muted-foreground`, `text-faint`, `border-border`, `text-ok`, `bg-gold`, `ease-snap`, `text-sm`, `rounded-lg`.

Never write a raw colour (`#7aae7a`, `oklch(...)`, `rgb(...)`), an arbitrary colour class (`bg-[#121a1b]`, `text-[oklch(...)]`), a Tailwind palette colour (`bg-green-500`, `text-zinc-400`) or a `var(--dither-color-*)` outside `src/lib/dither` and `shared.tsx`. A raw value escapes every future palette change and every contrast fix in `index.css`.

The only colour literals allowed are the ones the primitives in `src/components/ui/` already contain (`bg-black/50` scrims). Do not copy them into screens.

## Rules that apply to every screen

1. One `variant="primary"` (gold) button per view. Two gold buttons means the screen has no hierarchy. See [buttons](docs/design/buttons.md).
2. Green means "up to date" or "done", never "click me". Green is not a button fill.
3. Violet (`ring`, `dither-purple`) means focus or guidance (tour, tips, info toasts). It never reports machine state.
4. Every status colour sits next to a text label. Colour and shape reinforce; the word carries the meaning.
5. Motion: 150ms state changes, 200ms popovers and tooltips, 300ms overlays, all on `ease-snap`. Everything else is instant. See [motion](docs/design/motion.md).
6. Under reduced motion, nothing moves: durations drop to 0 and a fade may replace a slide.
7. Workspace pages never build their own spinners or skeletons. `Body` draws them.
8. Toasts are bottom-right, set once in `App.tsx`. Never pass `position` to a toast.
9. The GUI never shows a CLI equivalent of an action it can perform. Commands appear only for steps a person runs on another machine or that only a person can do. See [code and commands](docs/design/code-and-commands.md).
10. Commands, paths, keys, hostnames and ports use Ioskeley Mono (`font-mono` or `Mono`). Interface text uses Manrope.
11. Icons are Solar only, from `@/components/icons`. Never import another icon set.
12. No em dashes in any copy, comment or doc. Use a colon, a comma, or two sentences.
13. Hit targets: 40px for fine pointers, 44px for coarse pointers (`pointer-coarse:`), even when the drawn control is 28px.

## Topic files

| File | Read it when you |
| --- | --- |
| [colors](docs/design/colors.md) | pick a background, text, border or state colour |
| [typography](docs/design/typography.md) | set a font size, weight or the mono face |
| [icons](docs/design/icons.md) | add, size or colour an icon |
| [motion](docs/design/motion.md) | animate anything, or show loading |
| [buttons](docs/design/buttons.md) | add any button or menu action |
| [pages](docs/design/pages.md) | add a workspace page, header, toolbar or empty state |
| [lists](docs/design/lists.md) | show rows, columns or a detail panel |
| [forms](docs/design/forms.md) | add fields, settings rows, validation or a save flow |
| [overlays](docs/design/overlays.md) | choose between dialog, sheet, popover, menu and tooltip |
| [feedback](docs/design/feedback.md) | report status, progress, success or failure |
| [dither](docs/design/dither.md) | use dithered art, bands or progress |
| [code and commands](docs/design/code-and-commands.md) | show a command, path or copyable text |
| [writing](docs/design/writing.md) | write any label, message or description |

## Where the parts live

- Tokens, keyframes and reduced-motion rules: `src/index.css`.
- Primitives (shadcn on Radix, restyled): `src/components/ui/`. Screens use these; they do not restyle their fills.
- Shared display components: `src/shared/shared.tsx`.
- Workspace layout kit: `src/workspace/kit.tsx`, plus `Column`, `Lede` and `ConfirmDialog` in `src/workspace/settings.tsx`.
- First-run setup kit: `src/onboarding/kit.tsx`. Its `Field` is not the workspace `Field`.
- Behaviour notes (routes, guidance, loading, focus, layout sizes): `README.md`.

## Primitives that are not part of the system

These files exist in `src/components/ui/` from the shadcn install but no screen uses them. Never import them; use the right-hand column.

| Do not use | Use instead |
| --- | --- |
| `Badge` | `StatusMark` + label for state, `ChangeMark` for changes, `GroupChips` for groups |
| `Tabs` | `Toolbar` + `ToolbarTab` (views with their own URL) |
| `Progress` | `DitherProgress` |
| `Separator` | `border-b border-border` on the block, or `DropdownMenuSeparator` in menus |
| `ScrollArea` | native `overflow-y-auto` (`Body` already scrolls) |
