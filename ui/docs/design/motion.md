# Motion and loading

Motion exists only to show what changed. The default is no motion: a page switch, a command palette, a keyboard zoom on the map all happen at once.

## Durations

| Change | Duration | Example in code |
| --- | --- | --- |
| A state change in place | 150ms | `AnimatedRow`, `AnimatedNumber`, button press `scale-[0.97]`, `Switch`, colour changes |
| A popover, menu, select or tooltip | 200ms open, 150ms close | `popover.tsx`, `dropdown-menu.tsx`, `select.tsx`, `tooltip.tsx`, `Collapsible` open |
| An overlay | 300ms open, 200ms close | `dialog.tsx`, `sheet.tsx` and their scrims |
| Instant | 0ms | page navigation, command palette, keyboard map controls, everything not listed |

Exits are quicker than entrances. The tour (200 to 240ms, `index.css`) and first-run setup (`STEP_MS` 240ms in `onboarding/kit.tsx`) sit inside the overlay band. Setup gets more motion than daily screens because people see it once; never bring setup's entrances, staggers or shakes into the workspace.

## Easing

One curve: `--ease-snap`, `cubic-bezier(0.175, 0.885, 0.32, 1.1)`.

- In class names: `ease-snap` (`transition-[scale] duration-150 ease-snap`).
- In `motion` or WAAPI code: import `SNAP` or `SNAP_EASING` from `@/lib/utils`. Never retype the numbers.
- `riseIn` (`lib/utils.ts`) is the stagger helper; setup uses it, the workspace does not.

Never use `ease-in`, `ease-out`, `ease-in-out` or a bare `transition` (which falls back to Tailwind's default curve). The only linear motion is progress that must not ease: the `DitherProgress` shimmer and setup's `finish-sweep`.

## What may move

- Movement: `transform` and `opacity` only. Write transforms as strings (`translateY(4px)`), not `motion`'s `y` shorthand, so the compositor runs them (`shared.tsx` comment).
- Colour, background and border colour may transition at 150ms.
- Height only for disclosure and list changes: `Collapsible` (CSS keyframes in `index.css`) and `AnimatedRow`.
- Never animate `width`, `top`, `left`, `margin` or `padding`.

## Lists that change

Wrap a list whose rows come and go in `RowPresence`, and each row in `AnimatedRow` keyed by the row's id (pass `as="li"` inside `<ol>`/`<ul>`). Rows present on mount don't animate.

```tsx
// Correct (source.tsx, Secrets)
<RowPresence>
  {ws.secrets.map((s) => (
    <AnimatedRow key={s.name}>
      <ListRow cols={cols} minWidth={colsMin}>…</ListRow>
    </AnimatedRow>
  ))}
</RowPresence>

// Incorrect: a hand-rolled transition with the wrong curve
<div className="transition-all duration-500 ease-in-out">…</div>
```

Counts that change after an action use `AnimatedNumber` (`ToolbarTab` counts, `GroupRow` counts, the publish button's revision number).

## Reduced motion

Under `prefers-reduced-motion: reduce`, nothing moves.

- CSS: `index.css` zeroes every transition and animation duration. Staggered CSS entrances also need `animation: none` there, because a zero duration keeps the delay; add new staggered classes to that block.
- `motion` code: read `useReducedMotion()` and pass `{ duration: 0 }` (the workspace's `useStateTransition`), or swap a slide for a fade (setup's `STEP_FADE`). Never keep the movement.
- WebGL dither: `DitherShader` shows its `stillTime` frame. `DitherBlock` shows fully, the shimmer hides.

## Continuous motion

Only three things loop: `StateBand` (at most 20fps, slow while idle), the `DitherProgress` shimmer while `running`, and the skeleton highlight while a page loads. Never add a spinner, pulse or shimmer of your own. A busy action changes its label (`"Updating…"`) and disables its button instead.

## Loading

Workspace pages show a skeleton on the first visit to each view, drawn by `Body` (`kit.tsx`) with skullet 0.0.3, measured from the real content so nothing moves on reveal.

- Put the page content inside `Body`; the skeleton follows. Never draw skeleton bars or spinners by hand.
- An action that fetches the page's data again passes `reloading` to `Body` (Sync's Check for updates, Follower Update secrets). Local state inside `Body` resets on reveal, so keep form drafts in pages that don't reload.
- `PageHeader`, the sidebar and dialogs never load. `DetailPanel` loads its body and footer, not its title.
- Mark decorative art with the `skullet-ignore` attribute so it draws no placeholder. `StateBand` and `DitherBlock` already carry it.
