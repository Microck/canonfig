# Feedback and status

```
How does the person learn about this?
 ├── A lasting state of a machine, item or service → StatusMark + label (StateLabel for follower states)
 ├── A state that needs them to act, with the action → Attention notice on the page
 ├── A field is wrong → inline error on Field / SettingRow (see forms.md)
 ├── An operation is running → disabled button with a busy label ("Checking…"), plus DitherProgress if it reports progress
 ├── An action they started just finished → toast
 ├── A check they ran on demand (Run health check) → results as StatusMark rows on the page, plus one toast summing them up
 └── How a page works → its page tip ("?"), never a banner
```

## Toasts

Sonner, themed in `components/ui/sonner.tsx`, placed once in `App.tsx`: bottom-right, 8px from the edges, lifted above the tour offer card through `--toast-lift`. Toasts close after 4s. Never pass `position`, `offset` or `duration` from a screen; the star prompt's `duration: Infinity` is the one exception because it waits for an answer.

| Call | When | Example |
| --- | --- | --- |
| `toast.success(title, { description })` | An action the person started completed and changed something | "Tunnel started", "Schedule saved" |
| `toast(title, { description })` | A neutral outcome: a stop, a removal, a copy, "nothing new" | "Tunnel stopped", "Command copied", "No newer revision" |
| `toast.error(title)` | The action failed and the person must do something else | "Couldn't copy. Select the text and copy it by hand." |

`toast.warning`, `toast.info` and `toast.loading` are themed but have no call sites. Never use them for status that lasts; that belongs on the page.

```tsx
// Correct (follower.tsx TunnelView, non-demo copy): a start is a success, a stop is neutral
if (next) toast.success("Tunnel started", { description: `Forwarding 127.0.0.1:17342 to ${SOURCE}.` });
else toast("Tunnel stopped", { description: "Applying changes, checking for updates and updating secrets wait until you start it again." });

// Incorrect: a toast for a validation error, and a success for a removal
toast.error("Invalid path");
toast.success(`Removed ${removing}`);
```

- The title states the outcome in a few words: "Schedule saved", "No newer revision". The description, when present, says the consequence. No exclamation marks.
- Removals and stops are neutral `toast`, never `success`: nothing was gained.
- Toast once, from the handler (or its `ws.later` callback) that finished the action. Never toast from a render or an effect that mirrors state.
- Never put a credential in a title or description (see [forms](forms.md)).

## StatusMark and StateLabel

`StatusMark kind` is `ok`, `warn`, `act`, `bad`, `offline` or `off`. Nothing else exists. Fill reads as progress (ring, half, three-quarter, check); a cross and a dashed ring mark the exceptions, so all six stay apart without colour. The mark is decorative: the label beside it carries the meaning.

```tsx
// Correct (follower.tsx TunnelView)
<span className="inline-flex items-center gap-1.5 text-base">
  <StatusMark kind={up ? "ok" : "offline"} />
  {up ? "Connected just now" : "Stopped"}
</span>

// Incorrect: a mark with no words, or a dot coloured by hand
<StatusMark kind="bad" />
```

For a follower state (`converged`, `drift`, `human-action`, `failed`, `offline`, `never-synced`, `excluded`), use `StateLabel state={…}`: it picks the mark, the wording from `STATE_META` and the tooltip.

```
Which status kind?
 ├── Working, connected, up to date → ok
 ├── Changed somewhere, waiting for a decision or an apply → warn
 ├── Only a person can move it on → act
 ├── Failed → bad
 ├── Can't be reached → offline
 └── Not set up, not used, not applied → off
```

## Attention

The notice for something that needs the person (`follower.tsx`): `tone` is `warn`, `act` or `bad`, a `title`, a body that says why, and `actions` (`size="xs"` buttons). It sits in the page flow above the content it concerns. Never build a coloured banner instead.

## Progress

Running operations use `DitherProgress` (see [dither](dither.md)) with a `label` naming the operation ("Running health check"), `running` while it moves, and the button that started it disabled with a busy label. Never use the `Progress` primitive: it has no call sites and draws a flat green bar.

## Guidance

Owned by `src/workspace/guide.tsx` and `src/tour/`. New screens add content, not new guidance surfaces.

- Page tips: one card per page with something non-obvious, in `page-tips.ts`, opened by `PageHeader`'s "?". Plain lists and settings forms get none, so tips stay rare enough to be read.
- Tour chapters: `tour-steps.tsx`. A step targets elements by `data-tour`; a chapter's `pages` must list every page its steps visit, in order.
- Get started list and tour offer: fixed per role; never add a second onboarding checklist.
- Star prompt: one toast after 15 minutes of visible use, once. Never add another promotional prompt.
- Guidance art and accents are violet (`dither-purple`, `ring`) so they never compete with the page's gold action.
