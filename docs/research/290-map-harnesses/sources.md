# Sources

Accessed 2026-11-13. External research used Keenable search and live fetch, all responses `paid: false`. Quotes and claims below come from fetched pages, not search snippets.

| Source | What it proves | Design consequence |
| --- | --- | --- |
| [React Flow sub-flows](https://reactflow.dev/learn/layouting/sub-flows) | `parentId` positions nodes relative to a parent, does not nest their DOM; parents precede children; `extent: parent` constrains movement; child edges render above nodes. | Independent graph children add ordering, focus and edge-layer costs. Harnesses do not need their own movable coordinates; semantic HTML inside one memoized machine node is simpler. |
| [Tailscale machine posture inspection](https://tailscale.com/docs/features/device-posture/monitoring-postures) | Search/filter machines, select one, inspect its postures, and filter passing/failing evidence. | Keep search and a list alternative. Separate a fleet overview from detailed evidence. This research did not access a live tailnet admin console. |
| [Datadog service map](https://docs.datadoghq.com/tracing/services/services_map) | Group by team/application; filter hundreds or thousands of nodes; inspect one service and pivot; nodes depend on observed traces in a chosen time window. | Disclosure and evidence age belong in the design. Never infer current remote health from a topology edge. |
| [Grafana node graph](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/node-graph/) | Clickable hidden-node markers limit visible complexity; nodes expose details on demand. | Summaries must name what is hidden and let users reach it. Counts alone cannot replace a searchable machine list. |
| [Railway services](https://docs.railway.com/services.md) | A project canvas has service tiles; clicking opens service settings; icons aid recognition; keyboard command palette provides another route. | Compare a compact topology with a persistent, unscaled inspector. The page does not establish nested or collapsible groups, so no such claim is made. |
| [Fly.io app information](https://fly.io/docs/apps/info) | App overview, machine list, and inspection of a single machine expose different information. The docs link the dashboard but demonstrate CLI inspection. | Fleet-to-machine detail is supported; no claim that Fly uses a nested canvas. A signed-in dashboard was not inspected. |

## Local primary evidence

All repository links below pin the researched main commit.

- Film: `/home/ubuntu/code/canonfig-film/film/out/canonfig-1080p.mp4`, map shot around 14-22 seconds. Reference frame and extraction command are retained here.
- Film `src/scenes/map.ts:183-250`: machine header, Canonical Folder, harness row and internal connections; one Source above followers.
- Film `src/storyboard.ts:158-182`: atlas, laptop, studio, build-box; named harness sets, categories and revision 7 to 8.
- Film `src/engine/chest.ts:54-68,208-236`: logo mesh identities and top-down logo rendering.
- [UI tokens](https://github.com/Microck/canonfig/blob/7070b8487191ec813e6405ab53d5591e9459a1df/ui/src/index.css): Ender colors, Manrope and Ioskeley Mono, density, radii.
- [Map](https://github.com/Microck/canonfig/tree/7070b8487191ec813e6405ab53d5591e9459a1df/ui/src/shared/machine-map): one machine per React Flow node; browser-local appearance; fit minimum 1.
- [Stress fixtures](https://github.com/Microck/canonfig/blob/7070b8487191ec813e6405ab53d5591e9459a1df/ui/src/break/main.tsx): M40 is forty followers; M320 is four followers in a 320px container.
- [GUI enrollment contract](https://github.com/Microck/canonfig/blob/7070b8487191ec813e6405ab53d5591e9459a1df/src/gui/contract/enrollment.ts#L44-L59) and [route](https://github.com/Microck/canonfig/blob/7070b8487191ec813e6405ab53d5591e9459a1df/src/gui/routes/enrollment.ts#L64-L69): Source inventory contains identities and invitations only.
- [Local harness contract](https://github.com/Microck/canonfig/blob/7070b8487191ec813e6405ab53d5591e9459a1df/src/gui/contract/synchronization.ts#L15-L28): detection and selection, not verification.
- [Source transport](https://github.com/Microck/canonfig/blob/7070b8487191ec813e6405ab53d5591e9459a1df/src/enrollment/source-server.ts): enrollment lifecycle and revision/blob/secret downloads; no follower harness observation upload.
- [Completion receipt](https://github.com/Microck/canonfig/blob/7070b8487191ec813e6405ab53d5591e9459a1df/src/runtime/layers.ts#L717-L830): application, independent verification and client loading remain separate.
- [Durable receipt types](https://github.com/Microck/canonfig/blob/7070b8487191ec813e6405ab53d5591e9459a1df/src/state/state-repository.types.ts#L79-L126): local run-level proof, no remote per-harness report.
- [GLOSSARY](https://github.com/Microck/canonfig/blob/7070b8487191ec813e6405ab53d5591e9459a1df/GLOSSARY.md), [architecture](https://github.com/Microck/canonfig/blob/7070b8487191ec813e6405ab53d5591e9459a1df/docs/architecture.md), and all three ADRs constrain domain wording, ownership, privacy and transport.

## Unavailable evidence

Octen design search had no configured key in this session. No beta access or paid upgrade was requested. The supplied film is the visual source of truth. Fly's live dashboard and private machine data were intentionally not accessed.

## Round 2 brand evidence

[brand-research.md](brand-research.md) records every official palette/asset URL, the logo alteration restrictions, neutral entries without a verified accent, and collisions with status colours. Kagi subscriber search found primary pages; direct page, PDF and raw source reads supplied the claims. No search snippet is treated as a usage grant.
