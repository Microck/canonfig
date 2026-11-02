# Dither

Ordered dithering is the system's only texture: empty states, state bands, progress, the convergence matrix and setup's backdrop. It replaces illustration, gradient fills and drop shadows. The engine is `src/lib/dither` (matrices, `fillStyle`, `DitherShader`); screens use the four components in `shared.tsx` and never call the engine.

```
What does the texture show?
 ├── Nothing here yet (empty list, empty card) → DitherBlock (through EmptyState when it is a list)
 ├── The live state of a machine behind a headline → StateBand (through StateHeader on Overview)
 ├── How far an operation has got → DitherProgress
 └── One item on one machine in the matrix → StateCell
```

Anything else gets no texture. Never put dither behind body text other than a `StateBand` headline, which fades it out under the text with a `background` gradient.

## Tones

Components take a `tone`, not a colour:

| Component | `tone` values | Default |
| --- | --- | --- |
| `DitherBlock` | `ok`, `warn`, `act`, `bad`, `muted`, `purple` | `muted` |
| `DitherProgress` | `ok`, `warn`, `act`, `bad`, `muted`, `purple` | `ok` |
| `StateBand` | `ok`, `warn`, `act`, `bad`, `muted` | `ok` |
| `EmptyState` | `muted`, `ok` | `muted` |

The tone follows the colour rules: state tones report state, `purple` is guidance only (the tour offer's block), `muted` is neutral. Never pass a hex or a CSS variable as a tone.

## DitherBlock

Empty-state art: a dotted block that thins away from one `edge` (`top`, `bottom`, `left`, `right`; default `bottom`), revealed once on mount in 600ms. Give it a height (`h-24`) or an absolutely placed box. It is `aria-hidden` and carries `skullet-ignore`.

```tsx
// Correct (guide.tsx TourOffer): guidance art fills its box behind the dismiss button
<div className="relative h-20 border-b border-border bg-panel">
  <DitherBlock tone="purple" edge="bottom" className="absolute inset-0" />
</div>

// Incorrect: an empty state drawn with a gradient image
<div className="h-24 bg-gradient-to-t from-green-500/20" />
```

## StateBand

The dithered band behind a machine-state header. `mode="idle"` drifts in the tone's own way (ok calm, warn breathing, act flowing, bad glitching, muted nearly still); `mode="running"` replaces that with a sweep during a publish or sync. Place it as the first child of a `relative isolate overflow-hidden` section with `className="-z-10"`.

```tsx
// Correct (kit.tsx StateHeader)
<section className="relative isolate overflow-hidden border-b border-border" aria-live="polite">
  <StateBand tone={tone} mode={running ? "running" : "idle"} className="-z-10" />
  …
</section>

// Incorrect: a band used as decoration on a settings page, with a raw colour
<StateBand tone="#7aae7a" />
```

Only Overview (through `StateHeader`) and the Sync page's header use it. A new page reports state with `StatusMark` rows instead.

## DitherProgress

A 6px track whose fill is a dither ramp densest at the leading edge. `value` is 0 to 100, `label` is required (the progressbar's accessible name, naming the operation), `running` adds the shimmer until 100. Use it for any operation that reports progress; there is no other progress bar.

```tsx
// Correct (settings.tsx DoctorView): the wrapper reserves the bar's height while it comes and goes
<div className="mb-4 h-1.5">{running && <DitherProgress label="Running health check" value={progress} />}</div>

// Incorrect: the flat primitive with no accessible name, popping in and pushing content down
{running && <Progress value={progress} />}
```

## StateCell

One square in Overview's item-by-machine matrix: solid for up to date, hatched for attention, dotted for not applied or excluded. Matrix only.

## Budget and motion

- Each `StateBand` and `DitherShader` holds a WebGL context. The page shares `MAX_LIVE_CONTEXTS` (8); shaders off screen give theirs up. Never put a shader in a list row. The machine map's glow on a syncing node is the only per-item shader.
- Shaders draw at 20fps or less, pause when the tab is hidden, and show one still frame (`stillTime`) under reduced motion.
- Static fills (`DitherBlock`, `StateCell`, the progress ramp) are CSS backgrounds and never repaint.
