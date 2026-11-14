# Harnesses on the machine map: decision

Decided after round 2, when the maintainer judged the Film and Focus prototypes unfinished and asked for the design
to be done directly rather than through another prototype round.

## Direction

- The product's own `MachineMap` grows the film's card. No separate map. A machine that reports its harnesses shows
  a header, its `~/.canonfig` folder, branches, and one card per harness. A machine that reports nothing keeps
  today's plain card.
- Everything the plain map already had stays: dithered device tiles, Customize, saved positions, state-styled edges
  with packets, the legend, smooth zoom and Reset layout.
- The header carries revision and state on the right, as in the film, so the body only holds the folder and harnesses.
- The Source's folder lists the categories it holds as chips. Followers show only the path, like the film.
- Harness cards are 160 by 52px, in rows of up to three. Branches run from the folder to the first row.
- Card sizes come from `machineSize` in `ui/src/shared/machine-map/model.ts`, so the default layout knows each size
  before React Flow renders. Rows wrap by count (6) or width (2,100px).
- Fit may zoom out to 0.8, down from 1. That keeps a four-follower fleet in one view at 1080p.
- Logos are the official marks at 48px, unaltered, on a neutral tile. Harnesses without a mark show their initial.
- A harness card shows a state only when one holds for that harness. This machine's harnesses take the machine's
  state only for states that cover every harness: converged, failed, never synced, offline. Drift and Human Action
  Required name one item, so those cards say "Managed". The Source has no follower state, so its cards say
  "Managed" too.

## Rejected

- **Focus** (expand the selected machine): the layout and camera jump on every selection, and the fleet view
  still hides what each machine runs.
- **Rail** (side inspector): it splits attention between the map and the panel, and the film puts the harnesses in
  the cards.
- **Separate prototype map** (rounds 1 and 2): it rebuilt nodes, edges and controls, and lost the product's
  polish: tiles, packets, legend and Customize. At fleet zoom it collapsed into empty boxes.
- **Stylized logos and per-harness card colours**: Anthropic, OpenCode and Gemini forbid altering their marks
  ([brand research](brand-research.md)). Brand tints also collided with status colours: Claude's orange with amber
  warnings, green brands with "Up to date".
- **Machine state copied onto every harness**: one edited file made every harness read "You edited this".

## Still open

- Followers send no harness report to the Source, so in live mode only this machine's harnesses appear. Demo
  followers carry example reports. The [proposed contract](README.md#proposed-end-to-end-contract-for-phase-7)
  covers what a follower must send.
