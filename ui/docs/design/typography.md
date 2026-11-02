# Typography

Two faces, both self-hosted in `public/fonts` with their licences and declared in `src/index.css`:

- **Manrope** (`font-sans`, the default on `html`): every piece of interface text.
- **Ioskeley Mono** (`font-mono`): text a person could type into a terminal or a config file, and numbers that change in place.

Never load another font, and never set `font-family` inline. The one inline font in the app forces Manrope onto Sonner's toaster, which ships a system stack (`sonner.tsx`).

## Sizes

The root stays at 16px so Tailwind's spacing scale keeps its values (`gap-2` is 8px). Text sizes are redefined in `@theme`:

| Class | Size | Use |
| --- | --- | --- |
| `text-xs` | 11px | Column heads, chips, counts, `Mono` values in rows, tooltips |
| `text-sm` | 12px | Descriptions, field labels, field errors, secondary row text, buttons |
| `text-base` | 13px | Body text: row names, `Lede`, `SectionLabel`, settings titles, dialog descriptions |
| `text-lg` | 15px | Page title (`PageHeader` h1) |
| `text-xl` | 20px | The Overview state headline (`StateHeader`), the not-found heading |
| `text-2xl` | 28px | The first-run setup headings only |

Never go below 11px: the machine map keeps node text at 11px or more at every zoom fit (README). New code writes the class, never `text-[Npx]`; every size above has one. `PageHeader`, `StateHeader` and parts of onboarding still write pixel values that equal a class; do not copy them.

```
What size is this text?
 ├── The page's own title → PageHeader does it (15px/600)
 ├── A heading inside the page → SectionLabel (13px/500, muted)
 ├── Something the person reads as content → text-base
 ├── Something that explains or labels that content → text-sm
 └── Metadata, counts, column heads, chips → text-xs
```

## Weights

Use `font-medium` (500) for names, titles and labels, and `font-semibold` (600) for the page title and the state headline. `font-bold` (700) is not used on screens. Never write `font-[510]` or other in-between weights: the mono face has static files only at 400, 500, 600 and 700, and the browser would jump to the next heavier file (`index.css` comment).

## Mono

Use `font-mono` for:

- commands, paths, file names, config keys, secret names and group names (`GroupChips` sets it; the reserved secrets group shows its plain name in Manrope);
- hostnames, addresses, ports and fingerprints (`127.0.0.1:17342`, `SHA256:...`);
- inputs that take any of the above (`className="font-mono text-sm"`);
- numbers that change while the person watches: `AnimatedNumber` sets `font-mono tabular-nums` so digits keep their width.

Use the `Mono` component (`shared.tsx`) for an inline value: it is `font-mono text-xs text-muted-foreground`. Inside `SettingRow`, where the value is the content, pass `className="text-foreground"`.

```tsx
// Correct: a forwarding address in a settings row (TunnelView)
<SettingRow title="Forwarding">
  <Mono className="text-foreground">127.0.0.1:17342 → atlas:17342</Mono>
</SettingRow>

// Incorrect: a hostname in Manrope, sized by hand
<SettingRow title="Forwarding">
  <span className="text-[11px]">127.0.0.1:17342</span>
</SettingRow>
```

Static numbers in a column (times, counts that don't animate) take `tabular-nums` without switching face.

## Wrapping

- `h1`, `h2`, `h3` get `text-wrap: balance` globally. Paragraphs add `text-pretty`.
- Names in rows `truncate` and carry the full text in `title`. Health warnings and status values wrap instead (`StatusRow`): a warning cut mid-word is worse than a second line.
- Paragraphs cap at `max-w-[70ch]` (`Lede`) or `max-w-[68ch]` (`Attention`).

## Glossary words

Canonfig's domain terms (Source Machine, Follower Drift, Local Overlay) show as plain words with a dotted underline through `Term` (`shared.tsx`, terms in `GLOSSARY`). Use `<Term term="...">` the first time a concept appears in a `Lede` or description. Never put a `Term` inside a button or link: it is its own tab stop.

`term` only accepts a `GLOSSARY` key, and the keys follow the repo's domain glossary in `CONTEXT.md`. Everyday words ("proxy", "tunnel") are not terms; write them plainly. A new Canonfig concept goes into `CONTEXT.md` first, then `GLOSSARY`.
