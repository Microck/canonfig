# Configuration choice catalogue

Use this as a coverage checklist, not a questionnaire to paste into chat.
Simple exposes essential fields plus an editable summary. Advanced offers every
relevant section and supports keeping it as a whole. Both use the question
format in [questions.md](questions.md) for every editable field below.

## Construct each menu

Take the row's purpose for `Why it matters`. Turn observed values and supported
alternatives into numbered choices with brief consequences. Mark the safest
applicable choice `Recommended` and explain why. Append numbered
`Other (type your own)` even for enum, boolean, list, nested, and approval fields.
Other is a route to validated input or clarification, not an unsupported feature.

For free-form fields, offer Keep current (when present), Use a verified detected
value or explicitly labelled proposal (when available), and Other. If there is
no valid preset, offer Enter a custom value / Defer / Other; deferred required
values block the affected stage. Do not invent tokens, accounts, profiles,
versions, file paths, or package identifiers to fill a menu.

For lists, offer Keep current / Choose detected entries (multi-select) / None
(only when optional) / Other. Drill into one chosen record at a time. For nested
objects, offer Keep / Edit selected fields / Add a record / Other. Apply the same
menu rule recursively to every field in that record, including harness-specific
settings keys. This avoids an endless flat form.

Preserve valid state before suggesting defaults. Existing discoveries establish
candidates, not ownership, authorization, or a requirement to enable them.

## Environment and machines

| Field(s) | Why it matters | Candidate choices to number |
| --- | --- | --- |
| Setup mode | Controls question depth, not permissions | Simple; Advanced (in-depth) |
| Goal / role | Chooses configuration authority or CLI-only work | Source; Follower; CLI only |
| State owner | Credentials and jobs belong to an OS account | Keep observed owner; current non-root user; another confirmed account |
| Existing state | Avoids accidental reinitialization | Keep/resume; inspect only; defer conflict resolution |
| Package / version | Must match supported commands and runtime | Keep compatible installed version; documented exact version; another verified exact version |
| Install location / method | Controls PATH and account scope | Keep working user install; approved user-owned npm prefix; defer prerequisite installation |
| Prerequisite remediation | Missing runtimes are not permission to install | Use existing supported runtime; approve documented user-level installation; stop |
| Logging | Controls local lifecycle records | Keep; default local logging; disable; approved private path |
| Device source | Supplies machine candidates, not access grants | This machine; optional Tailscale peer listing; manual inventory; defer |
| Source device | Exactly one machine publishes | Keep confirmed Source; this machine; one explicitly selected visible peer; manual candidate |
| Follower devices | Defines the requested fleet | Current machine; selected peers (multi-select); manual inventory; none yet |
| Discovery refresh | Keeps selections tied to identities | Keep displayed snapshot; refresh with consent; manual entry |
| Connection / endpoint | Must preserve Canonfig loopback TLS pinning | Existing verified loopback origin; operator-managed TLS-transparent tunnel; defer |
| Source port / follower local port | Tunnel ports can differ between machines | Keep existing; observed free candidate; custom valid port |
| Tunnel ownership / availability | Scheduled sync needs the tunnel running | Keep verified operator-managed tunnel; manual-only sync; defer scheduling |
| Remote account / access | Device visibility is not OS login permission | Existing explicitly confirmed account; manual handoff; defer |

OS, architecture, shell, and tool availability are observations. When disputed,
offer Recheck / Choose another machine / Other instead of allowing an unsupported
platform to be declared supported. Never change firewall, ACL, SSH, Tailscale
Serve/Funnel, or login settings as a side effect of selecting a device.

## Harnesses, import, and takeover

| Field(s) | Why it matters | Candidate choices to number |
| --- | --- | --- |
| Harness list (`harnesses`, Source) | Decides which harnesses every machine projects into | Keep planned list; installed harnesses (multi-select); add ids followers use; `--harness` per id |
| Harness exclusions (`excludeHarnesses`, any machine) | Keeps one harness out on this machine only | Keep; none; `canonfig harnesses exclude <harness>`; `include` to undo |
| Import (Source setup) | Copies existing harness items into the folder before takeover | `--no-import`; chosen harnesses or item ids via `--import`; `--import-all` |
| Import collisions | Two items with one name, or one the folder already holds | Choose one id with `--import <id>`; edit or remove the folder copy; skip |
| Imported MCP secrets | Credential-looking values become `fromEnv` references | Export the named variables locally; rename a variable; skip the item |
| Takeover snapshot (`backups`, `--no-backup`) | Holds what the first apply replaces; `canonfig restore` writes it back | Keep snapshots (recommended); `--no-backup` for one apply; `"backups": false` in `local/local.jsonc` |
| Restore | Hands a harness back and excludes it here | Latest snapshot; a named snapshot; none |

## Canonical Folder (Source)

| Field(s) | Why it matters | Candidate choices to number |
| --- | --- | --- |
| Profile ID / display name (`profile`) | Required to publish; followers sync this Machine Profile | Keep; proposed machine-class ID/name |
| Instructions (`AGENTS.md`) | Global instructions for every harness that supports them | Keep; imported content; edit; empty |
| Rules (`rules/<id>.md`) | Frontmatter `description`, `paths`, `activation` (`always`, `path`, `manual`, `model`) | Keep; imported rules; add one; none |
| Skills (`skills/<name>/SKILL.md`) | Frontmatter `name`, `description`, plus the skill's files | Keep; imported skills; add one; none |
| Agents (`agents/<id>.md`) | Frontmatter `description` (required), `model`, `tools`, `writable` | Keep; imported agents; add one; none |
| Commands (`commands/<id>.md`) | Frontmatter `description` (required), `argumentHint` | Keep; imported commands; add one; none |
| MCP servers (`mcp.<name>`) | `stdio` (`command`, `args`, `env`, `cwd`) or `streamable-http`/`sse` (`url`, `headers`) | Keep; imported servers; add one; disable with `"enabled": false` |
| MCP secrets | Values stay out of the folder | `{ "fromEnv": "NAME" }`; shared secret through `canonfig secrets set`; defer |
| Dependencies (`requires`) | An MCP server's tools install before it is projected | Keep; `tools/<id>` entries; none when independent |
| Hooks (`hooks[]`) | `id`, `event`, `matcher`, `run`, `timeoutMs`, `onFailure` (`block`, `warn`, `ignore`); runs code on followers | Keep; script under `hooks/`; command on PATH; none |
| Settings (`settings.<harness>`) | Keys merged into that harness's settings file | Keep; reviewed keys; none |
| Groups (`groups.<name>`) | Items (`instructions` or `<category>/<name>`) only that group's followers receive | Keep; no additional groups; add a justified group |
| Local policy (`local.allow`) | Categories followers may add through `local/` | Keep; none; choose from `rules`, `skills`, `agents`, `commands`, `mcp`, `settings` |
| Profile schedule default (`scheduleDefault`) | Offers a calendar, not implicit scheduling consent | Keep; supported daily; supported weekly |
| Discovery inputs | Bounds which files `setup plan --file` may read for tool discovery; never selects synced content | Selected observed files (multi-select); none |

Unknown keys and frontmatter fields fail to load, so offer only fields this
table names. Never put a credential value in the folder; publication rejects
credential-looking literals.

## Machine-local items (`local/`)

| Field(s) | Why it matters | Candidate choices to number |
| --- | --- | --- |
| `local/rules/`, `local/skills/`, `local/agents/`, `local/commands/` | Added to the published items on this machine only | Keep; add one in a category `local.allow` admits; none |
| `local/local.jsonc` `mcp`, `settings` | Machine-only MCP servers and harness settings | Keep; add one; none |
| Name collisions | A local item named like a published one is Human Action Required | Rename the local item; remove it; ask the Source |

`local/` is never published and never replaced. A category the Source's
`local.allow` does not list is reported and not projected.

## Tools, credentials, agents, schedules

| Field(s) | Why it matters | Candidate choices to number |
| --- | --- | --- |
| Tool executable (`tools.<id>.executable`) | The command followers verify | Detected verified executable; `source scan` proposal; defer |
| Per-platform recipes / method / package / exact version | Prevents installing a similarly named wrong package | Keep reviewed recipe; choose upstream-backed supported recipe; defer |
| Artifact / integrity / Python index | Bounds provenance and supply sources | Keep verified artifact/index; default supported registry; reviewed credential-free alternative |
| Build policy / steps / executables / paths / origins | Build scripts execute code | Scripts disabled; manually reviewed required build with explicit bounds; defer unsupported automation |
| Login required / instructions | Identifies a human prerequisite without copying credentials | No login when verified; existing local login; human login with non-secret instructions |
| Verification (`tools.<id>.verify`) | Proves the tool independently | Keep valid check; executable present; command check |
| Credential reference (`credentials.<id>.reference`) | Keeps secret values outside the folder | Existing symbolic reference; native store reference; defer unavailable storage |
| Shared-secret authority / names / recipients | Separately grants sensitive values to followers | Keep disabled; review explicitly required names and recipients; defer |
| Invitation groups / lifetime / delivery | Limits enrollment scope and exposure | Minimal declared groups; 15m proposed expiry or another supported expiry; local private delivery |
| Agent policy | Separates deterministic work, proposals, and execution | deterministic-only; agent-propose; agent-apply with separate approval |
| Agent harness kind / executable | Selects the actual local executor | Existing configured adapter; verified codex/claude executable with optional model; custom executable and arguments; none |
| Path / executable / HTTPS origin allowlists | Bounds agent actions | Keep minimal valid set; select task-required entries; none/deny |
| Elevation / login / restart / reboot | Changes privileged or disruptive behavior | Denied; explicitly scoped human decision; defer |
| Maximum input bytes | Limits material passed to an agent | Keep verified bound; tighter supported bound; validated custom integer |
| Schedule enablement / calendar / timezone | Controls unattended apply behavior | Keep existing/manual; verified profile default (`schedule set --default`); supported daily/weekly outside a daylight-saving gap; detected or explicit IANA timezone |
| Scheduled executable / failure visibility | Unattended jobs use a different environment | Keep verified path/output; observed absolute path and native job evidence; defer |
| Recovery / drift choice | Protects interrupted work and local changes | Inspect; resume persisted recoverable run; keep local edit; restore Source content |
| Publication / apply / restore approval | Makes the mutation boundary explicit | Approve displayed stage; edit; stop |

Do not offer a package manager absent from the runtime's supported recipe set,
guess an architecture-specific package, or promise arbitrary cron/custom
schedules through a CLI limited to daily/weekly calendars. Shared-secret grants
are not necessarily per-name access controls: inspect the installed sharing
contract before promising per-secret isolation. Never treat a grant as merely
another default accepted in bulk.

Do not ask the user to define empty optional sections. In Advanced, the section's
Disabled/Keep answer closes it. In Simple, requested or detected sections appear
in the editable summary; they are not silently dropped. Secret defaults must
never contain real values.
