# Code, commands and copy

## No CLI equivalents

The GUI never shows the command that does what a GUI control does. A Save button does not come with "or run `canonfig schedule set …`". Showing both teaches people that the button is a wrapper they should bypass, and doubles every string that can drift from the CLI.

A command appears only when the GUI cannot do the step itself:

- the step runs on another machine (invitation and enrollment steps, `machines.tsx`);
- the step needs a person at a terminal on this machine (`gh auth login`, `sudo loginctl enable-linger`, a health check's fix).

```
Does the person need to type this command?
 ├── The GUI can do it here → no command; give them the button
 ├── It runs on another machine, as one of several numbered steps → Cli wrap inside a Step
 ├── It runs in a terminal here, as a stand-alone fix → CommandBox
 └── It is a short command inside a sentence of prose data → WithCode (backticks in the text)
```

## CommandBox

A block of one copyable command for a step a person runs elsewhere: mono 12px text on `bg-canvas/60` with a hairline, truncated with the full text in `title`, and a ghost copy button that turns into a green check for 1.5s.

```tsx
// Correct (settings.tsx SetupView): a step only a person can do
<p className="text-base"><Term term="Human Action Required">This step needs you.</Term> Canonfig never changes linger itself, so run this in a terminal, then resume.</p>
<CommandBox>{LINGER_FIX}</CommandBox>

// Incorrect: a CLI equivalent beside a GUI action
<Button variant="primary">Save schedule</Button>
<CommandBox>canonfig schedule set --daily 09:00</CommandBox>
```

Cap its width in prose (`max-w-sm`) so the copy button stays near the text.

## Cli

A `$`-prefixed command line with a copy button, for commands run on another machine. Pass `wrap` inside dialogs so long commands break instead of truncating. It has one caller today: the numbered `Step` in the invitation dialogs (`machines.tsx`), which puts it in the same `bg-canvas/60` well as `CommandBox`. Use `Step` for a new multi-step flow; never put `Cli` loose in a page.

```tsx
// Correct (machines.tsx invitation dialog)
<Steps>
  <Step
    title="Copy the file to the other machine, for example with scp:"
    command={`scp ${shq(result.file)} ${host}:~/`}
    note="A USB stick or any private file transfer works too. The steps below expect it in the home folder there."
  />
</Steps>

// Incorrect: a loose command line on a page, for something the GUI could do itself
<Cli>canonfig follower enroll --name atlas-mini</Cli>
```

`Steps` and `Step` are private to `machines.tsx`; move them into `kit.tsx` before a second file needs them, rather than copying them.

## WithCode

Renders `backtick` spans in data strings as copy chips: a mono chip with a hairline that copies its text on click, with a "Copy" tooltip and the same toast as the copy buttons. Use it for commands mentioned inside sentences that come from data (the Source Overview's attention reasons and fixes, `source.tsx`). Never render it inside a button or link: the chip is a button and would nest.

## Copying

Every copy goes through `copy(text, what)` (`kit.tsx`): it writes to the clipboard, toasts `what` with the text as description, and on failure toasts the error "Couldn't copy. Select the text and copy it by hand." Never call `navigator.clipboard` directly. Name what was copied in `what` ("Command copied", "Fingerprint copied"). Never copy a credential: the toast would show it.

## Mono values

Paths, keys, hosts, ports, fingerprints and group names inside text use `Mono` (11px muted) or `font-mono` on the element (see [typography](typography.md)). They are values, not commands: no `$`, no copy button unless the person needs the value elsewhere, in which case use a panel footer action ("Copy fingerprint").
