# Writing

The GUI talks to one person about their machines, in plain words. Match the existing voice; these rules are what that voice is.

## Punctuation

- No em dashes, anywhere: copy, comments, docs. Use a colon, a comma, parentheses or two sentences.
- `…` (one character) ends a button or menu label that opens a dialog or asks for more ("Remove…", "Replace value…") and a busy label ("Updating…", "Starting…"). Never three dots.
- Labels, titles, buttons and column heads: sentence case, no final period ("Save schedule", "Updated on atlas").
- Descriptions, ledes, hints, errors and toast descriptions: complete sentences with periods.
- No exclamation marks.

## Words

- Use the plain word from `GLOSSARY` (`shared.tsx`): "Source", "follower", "item", "revision", "local setting", "local edit", "needs you". The Canonfig term ("Follower Drift") lives in the `Term` tooltip, not the label.
- Address the person as "you" and their machine as "this machine"; name other machines by hostname ("atlas"). Never "the user", never "we".
- Contractions are normal: "can't", "isn't", "aren't saved".
- Times in 24-hour form ("09:00", "today at 08:45"); counts as digits.
- Write complete, natural sentences. Never a run of fragments ("Fast. Simple. Secure.").

## Buttons

Verb plus object, naming the result: "Save policy", "Start tunnel", "Publish revision 4", "Add to profile". Never "OK", "Submit", "Yes", "Confirm". A confirm button repeats the action it confirms ("Stop syncing", "Discard changes"); its cancel is "Cancel" or "Keep editing".

## Errors and warnings

Say what to do, in the words a person would use: "Enter a path that starts with /, ~/ or ./." "Add this path or clear the field before saving." "Couldn't copy. Select the text and copy it by hand." Never "Invalid input", "Error", or a code.

When something is blocked, say why and where to fix it: "The SSH tunnel is stopped, so this machine can't reach atlas. Start it in Settings, SSH tunnel."

## Claims

Say only what the app has checked. A path field checks the shape of the path, not that it exists, so its copy never says the path exists (`settings.tsx`). Copy about the simulation itself ("in this demo workspace") appears only behind the `DEMO` flag (`shared/data.ts`).

## Correct and incorrect

```tsx
// Correct (kit.tsx useLeaveGuard)
<DialogTitle>Discard unsaved changes?</DialogTitle>
<DialogDescription>Your edits to {label} aren't saved. Leaving now discards them.</DialogDescription>
<Button variant="ghost">Keep editing</Button>
<Button variant="destructive">Discard changes</Button>

// Incorrect: a title that says nothing, and generic buttons
<DialogTitle>Warning! Are you sure?</DialogTitle>
<Button>No</Button>
<Button>Yes</Button>
```
