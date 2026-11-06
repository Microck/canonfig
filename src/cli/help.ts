import { buildIdentity } from "../runtime/build-identity.ts";
import { CliExitCode } from "./exit-codes.ts";

// This module and its imports load no Effect and no command graph: the
// entrypoint answers help and --version from here before importing anything
// heavy, which is most of what a CLI start used to cost.

export const programName = "canonfig";
export const programDisplayName = "Canonfig";
export const programVersion = "6.1.1";

const helpHeader = `${programDisplayName} ${programVersion}`;

export const installerHelp = [
  "  installer list",
  "  installer set <method> --executable <absolute-path> [--arg <absolute-entrypoint>]",
  "  installer check <method>",
  "  installer remove <method>",
].join("\n");

/**
 * One command group as it appears in help. `areas` are the first argv tokens
 * that select the group, so `canonfig abandon --help` finds the recovery
 * group. Groups dispatched before `evaluateCli` (secrets, skills, installer)
 * print their own detailed help; the global listing still names them so no
 * group is discoverable only from the website.
 */
export interface HelpGroup {
  readonly title: string;
  readonly areas: ReadonlyArray<string>;
  readonly usage: ReadonlyArray<string>;
  readonly notes?: ReadonlyArray<string> | undefined;
}

export const helpGroups: ReadonlyArray<HelpGroup> = [
  {
    title: "Browser interface",
    areas: ["ui"],
    usage: ["ui [--port <n>] [--no-open]"],
    notes: [
      "Open the local browser interface with live Overview status for this machine.",
      "Runs in the foreground on 127.0.0.1 with a random port by default.",
      "The printed sign-in URL works once. --no-open leaves opening it to you.",
      "Press Ctrl-C to stop. Other screens remain available only in the public demo.",
    ],
  },
  {
    title: "Self-update",
    areas: ["self-update"],
    usage: ["self-update enable|disable|status|check|apply|auto [--apply]"],
    notes: ["Opt-in stable patch updates for user-private global npm installations; see self-update --help.", "Active commands and unfinished syncs block activation. Major/minor fleet upgrades remain manual."],
  },
  {
    title: "Source Machine",
    areas: ["source"],
    usage: [
      "source init",
      "source scan [--write]",
      "source publish --reviewer <name>",
      "source serve [--host <127.0.0.1|::1>] [--port <port>]",
      "source service install [--host <127.0.0.1|::1>] [--port <port>]",
      "source service status",
      "source service remove",
      "source invite --endpoint <https-url> --output <path> [--expires <duration>] [--group <name>...]",
      "  [--timeout-ms <ms>]",
      "source revoke <follower-id>",
    ],
    notes: [
      "publish compiles ~/.canonfig/ (canonfig.jsonc, AGENTS.md, rules/, skills/,",
      "agents/, commands/, hooks/, files/) into the next signed revision; nothing else",
      "in the folder is published. Republishing content equal to the latest revision",
      "returns that revision; any other content, including an older revision's, becomes",
      "the next sequence.",
      "scan is tool discovery: it reads the folder's instructions, skills, hook scripts and",
      "MCP commands and proposes tools entries. --write adds the accepted ones to",
      "~/.canonfig/canonfig.jsonc, keeping its comments.",
      "service installs a native user service that runs source serve (systemd user",
      "unit, launchd agent, or Task Scheduler at-logon task); serve runs in the foreground.",
      "invite writes a mode-0600 single-use envelope; move it over a private channel.",
    ],
  },
  {
    title: "Follower enrollment",
    areas: ["follower"],
    usage: [
      "follower enroll --stdin --name <name> [--replace] [--timeout-ms <milliseconds>]",
      "follower unenroll",
    ],
    notes: [
      "Pipe the invitation envelope: cat ./canonfig-invite | canonfig follower enroll --stdin ...",
      "The invitation is never accepted as an argument. A Source publishes one profile;",
      "the follower follows it.",
      "Enrolling hands this machine's own projection records to the follower identity, so",
      "later syncs update those harness surfaces from the Source.",
      "--timeout-ms bounds each enrollment network phase (default 10000; maximum 300000).",
      "An active follower name cannot be enrolled again; revoke it on the Source first.",
      "Re-enrolling a revoked name keeps local settings. --replace enrolls a new identity,",
      "revokes the old one, and",
      "lists what it reset (agent policy, harness and secret bindings, schedule).",
      "unenroll revokes this identity on the Source, deletes its local credential and",
      "received shared secrets, and leaves applied files in place.",
    ],
  },
  {
    title: "Synchronization",
    areas: ["sync"],
    usage: [
      "sync [--plan | --apply] [--no-input] [--review-local] [--no-backup]",
    ],
    notes: [
      "On an enrolled follower, sync fetches the latest authorized revision, mirrors its",
      "items into ~/.canonfig/ and projects the mirror plus ~/.canonfig/local/ in one run.",
      "A mirror file edited on this machine is drift: it is kept, reported, and its",
      "projections hold.",
      "On the Source or an unenrolled machine, sync projects ~/.canonfig/ into the",
      "harnesses listed in ~/.canonfig/canonfig.jsonc that are installed and not",
      "excluded on this machine. A listed harness that is not installed is reported as",
      "not installed; what Canonfig applied to it earlier stays as it was.",
      "--plan (the default) compares without changing managed targets; a projection plan",
      "lists every harness surface it would take over and whether it keeps a backup.",
      "--apply journals every action and verifies each resource independently. Before",
      "Canonfig first writes a harness surface it copies the prior content to a takeover",
      "snapshot in ~/.canonfig/.backups/ (the first snapshot and the 4 most recent are kept).",
      "--no-backup takes over without a snapshot, as does \"backups\": false in",
      "~/.canonfig/local/local.jsonc.",
      "Outputs that canonfig.jsonc local.appendLocal shares with this machine keep its own",
      "text below the Source section, or its own entries beside Canonfig's. --review-local",
      "with --plan writes each first adoption's exact text to private JSON files under",
      "~/.canonfig/.reviews/. They may hold secrets: read them locally, never share them.",
      "--no-input never prompts. Native schedules run: sync --apply --no-input --scheduled",
    ],
  },
  {
    title: "Recovery",
    areas: ["recover", "abandon", "restore"],
    usage: [
      "recover [--no-input]",
      "abandon",
      "restore [<snapshot>]",
    ],
    notes: [
      "recover resumes or rolls back the interrupted run from its journal.",
      "abandon closes a run recover cannot resolve; it does not roll anything back.",
      "restore writes a takeover snapshot back (the latest by default) as a journaled run,",
      "releases those surfaces and excludes their harnesses (and resources) in",
      "~/.canonfig/local/local.jsonc. An append-local surface keeps this machine's content",
      "and loses only Canonfig's part. It refuses a surface that changed since Canonfig",
      "last applied it. A snapshot that import --replace took puts those folder entries",
      "back, after a snapshot of them.",
    ],
  },
  {
    title: "Export and import",
    areas: ["export", "import"],
    usage: [
      "export [--output <file.tar.gz>] [--include-harnesses] [--force]",
      "import <file.tar.gz> [--dry-run] [--replace] [--expect-key <fingerprint>]",
    ],
    notes: [
      "export writes ~/.canonfig/canonfig.jsonc, AGENTS.md, rules/, skills/, agents/,",
      "commands/, hooks/, files/ and local/ to a private .tar.gz with a manifest.json of",
      "every file's size, SHA-256 and mode. On the Source it adds signature.json, the Source",
      "signing key's signature of the manifest. State, backups, the hook runtime, logs and",
      "credentials stay out, and a literal credential in canonfig.jsonc or local.jsonc",
      "refuses the export.",
      "--include-harnesses adds the harness files Canonfig manages here, under harnesses/, only",
      "where they still hold what Canonfig wrote; shared files contribute their owned keys.",
      "The output must be inside your home directory; --force replaces an existing file.",
      "import verifies the signature, if any, and every checksum, then writes the folder",
      "entries as a journaled run, and reports the signer's fingerprint or unsigned.",
      "--expect-key refuses an archive that key did not sign, unsigned ones included.",
      "It refuses an enrolled follower, and a folder that holds entries unless --replace,",
      "which snapshots those entries to ~/.canonfig/.backups/ first; restore puts them back.",
      "Harness files are verified, never written: sync projects the imported folder.",
      "--dry-run verifies and prints the plan without writing.",
    ],
  },
  {
    title: "Harnesses",
    areas: ["harnesses"],
    usage: [
      "harnesses",
      "harnesses include|exclude <harness>",
    ],
    notes: [
      "harnesses lists every harness: installed or not, listed in ~/.canonfig/canonfig.jsonc,",
      "excluded on this machine, the root pinned at takeover, and its latest takeover snapshot.",
      "Installed means an executable resolves through Canonfig's install directories,",
      "~/.local/bin, then PATH, without running it; Cursor's generic agent counts only",
      "with ~/.cursor present.",
      "exclude and include edit only this machine's exclusions in ~/.canonfig/local/local.jsonc.",
    ],
  },
  {
    title: "Local overlays",
    areas: ["overlay"],
    usage: [
      "overlay list",
      "overlay set <category>/<name>",
      "overlay remove <category>/<name>",
      "overlay set settings/<harness>#<key>",
      "overlay remove settings/<harness>#<key>",
    ],
    notes: [
      "A Local Overlay lets this machine's ~/.canonfig/local/ item replace the published",
      "item of the same name instead of stopping with a name collision. Categories:",
      "rules, skills, agents, commands, mcp, and settings/<harness> (local keys replace",
      "the published keys they overlap). The Source's local.allow must admit the category.",
      "A key claim, settings/<harness>#<key>, makes one key of that harness's settings file",
      "this machine's: Canonfig never writes, removes or reports drift on it there, and the",
      "other keys it owns in the file still follow the Source. Removing the claim lets the",
      "next sync write the published value again.",
      "Overlays and claims live in ~/.canonfig/local/local.jsonc and are never published.",
    ],
  },
  {
    title: "Status",
    areas: ["status"],
    usage: [
      "status [--follower <id>]",
    ],
    notes: [
      "On a follower, status reports enrollment, the applied revision, and the",
      "completion receipt. On the Source, --follower <id> reports that follower's enrollment.",
    ],
  },
  {
    title: "Diagnostics",
    areas: ["doctor"],
    usage: [
      "doctor [--no-input] [--timeout-ms <ms>]",
    ],
  },
  {
    title: "Managed SSH tunnel",
    areas: ["tunnel"],
    usage: [
      "tunnel start --invitation <path> --ssh-host <host> --ssh-user <user> --ssh-host-key-file <path>",
      "  [--ssh-port <port>] [--local-host <127.0.0.1|::1>] [--local-port <port>]",
      "  [--ssh-executable <path>] [--ssh-argument <arg>]... [--timeout-ms <ms>]",
      "tunnel start [--timeout-ms <ms>]",
      "tunnel status",
      "tunnel stop [--forget]",
    ],
    notes: [
      "Start the Source first, then the tunnel. The first start records the tunnel;",
      "tunnel start without --invitation restarts that record, so the invitation need",
      "not be kept. stop keeps the record (nothing restarts it); stop --forget deletes it.",
      "Scheduled syncs restart a tunnel that went down once before fetching.",
    ],
  },
  {
    title: "Profiles",
    areas: ["profile"],
    usage: [
      "profile list",
      "profile show <revision-id>",
    ],
  },
  {
    title: "Agent policy",
    areas: ["agent"],
    usage: [
      "agent policy [deterministic-only|agent-propose|agent-apply]",
      "agent harness [codex|claude|custom] --executable <path> [--model <name>] [--argument <arg>...] [--allow-path <path>...]",
      "  [--allow-leaf-executable <name>...] [--bind-secret <ENV=secret-name>...]",
      "  [--allow-origin <https-origin>...] [--allow-capability <capability>...]",
      "  [--maximum-input-bytes <bytes>]",
    ],
  },
  {
    title: "Journaled setup",
    areas: ["setup"],
    usage: [
      "setup plan --role <source|follower> [--scope <full|cli-only>] [--file <path>...]",
      "  [--mode <simple|advanced>] [--intent <text>]",
      "  [--harness <id>...] [--import <harness|item-id>... | --import-all | --no-import]",
      "setup approve --approver <name>",
      "setup apply",
      "setup status",
    ],
    notes: [
      "--file bounds tool discovery only. It does not choose which files are synced;",
      "the published profile does. --mode records the interview depth you chose; it",
      "does not change the plan. setup status shows role, scope, mode, discovery paths,",
      "approver, and completed stages.",
      "A full Source plan has a harnesses stage: it lists the installed harnesses (or",
      "the ones ~/.canonfig/canonfig.jsonc already lists) and scaffolds ~/.canonfig/",
      "(canonfig.jsonc, AGENTS.md, skills/). --harness replaces that list.",
      "The plan offers each selected harness's instructions, rules, skills, agents,",
      "commands and MCP servers for a one-time import and imports none by default.",
      "--import names a harness or an offered item id; --import-all takes every item;",
      "--no-import does not read the harnesses at all. Items whose names collide are",
      "listed as exclusions until one is named. Credential-looking MCP values become",
      "fromEnv references, and the plan lists each one. The plan digest covers the",
      "harness list and every chosen item, so changing either needs a new approval.",
    ],
  },
  {
    title: "Scheduling",
    areas: ["schedule"],
    usage: [
      "schedule set <daily@HH:mm|weekly:Day[,Day...]@HH:mm> [--timezone <IANA>] [--executable <path>]",
      "schedule set --default",
      "schedule status",
      "schedule remove",
    ],
    notes: [
      "Times are local to --timezone, or to this machine's zone. set prints the zone,",
      "the next run, and a warning when the time does not exist on a daylight-saving",
      "day. --default installs the profile's suggested schedule; sync never installs one.",
    ],
  },
  {
    title: "Shared secrets (details: canonfig secrets --help)",
    areas: ["secrets"],
    usage: [
      "secrets set <name>   (value on stdin only)",
      "secrets list",
      "secrets remove <name>",
      "secrets sync",
      "secrets bootstrap",
    ],
  },
  {
    title: "Upstream skills (details: canonfig skills --help)",
    areas: ["skills"],
    usage: ["skills track|list|check|update [--root <path>] [--name <id>...] [--apply]", "skills auto [--root <path>] [--name <id>...] [--apply] [--once] [--interval <seconds>]"],
  },
  {
    title: "Installer bindings (details: canonfig installer --help)",
    areas: ["installer"],
    usage: installerHelp.split("\n").map((line) => line.trim()),
  },
];

const exitCodeSummary = [
  "Exit codes:",
  "  0 success   1 internal defect   2 usage or configuration   3 Human Action Required",
  "  4 conflict or Follower Drift   5 authentication or revocation   6 transport",
  "  7 verification or apply failure",
];

const globalOptions = [
  "Global options:",
  "  -h, --help     Show help; after a command group, show that group's help",
  "  -V, --version  Show version",
  "  --json         Emit the stable canonfig.cli/v1 JSON envelope",
];

const usageBlock = (group: HelpGroup, program: string, prefix: string): ReadonlyArray<string> =>
  group.usage.map((line) =>
    line.startsWith("  ") ? `${prefix}    ${line.trimStart()}` : `${prefix}${program} ${line}`
  );

/** The complete listing: every command group, including the ones dispatched outside evaluateCli. */
export const renderGlobalHelp = (header: string, program: string): string => [
  header,
  "",
  `Usage: ${program} <command> [options]`,
  `       ${program} <command> --help`,
  "",
  ...helpGroups.flatMap((group) => [
    `${group.title}:`,
    ...usageBlock(group, program, "  "),
    "",
  ]),
  ...globalOptions,
  "",
  ...exitCodeSummary,
  "",
].join("\n");

export const helpGroupFor = (area: string): HelpGroup | undefined =>
  helpGroups.find((group) => group.areas.includes(area));

/** One group's usage and notes, for `canonfig <group> --help`. */
export const renderGroupHelp = (header: string, program: string, group: HelpGroup): string => [
  `${header}: ${group.title}`,
  "",
  "Usage:",
  ...usageBlock(group, program, "  "),
  ...(group.notes === undefined ? [] : ["", ...group.notes]),
  "",
  ...globalOptions,
  "",
  `Run '${program} --help' for every command group.`,
  "",
].join("\n");

const helpText = renderGlobalHelp(helpHeader, programName);

/**
 * `--help` anywhere shows help. After a command group it shows that group, so
 * `canonfig schedule --help` and `canonfig source publish --help` both answer
 * the question the user was asking instead of repeating the full listing.
 */
const helpFor = (arguments_: ReadonlyArray<string>): string => {
  const area = arguments_.find((argument) => !argument.startsWith("-"));
  const group = area === undefined ? undefined : helpGroupFor(area);
  return group === undefined ? helpText : renderGroupHelp(helpHeader, programName, group);
};

export type HelpOrVersionOutcome =
  | { readonly _tag: "Help"; readonly text: string; readonly exitCode: CliExitCode }
  | { readonly _tag: "Version"; readonly text: string; readonly exitCode: CliExitCode };

/** The help or version answer for these arguments, when they ask for one. */
export const helpOrVersion = (
  arguments_: ReadonlyArray<string>,
): HelpOrVersionOutcome | undefined => {
  if (arguments_.length === 0 || arguments_.includes("--help") || arguments_.includes("-h")) {
    return { _tag: "Help", text: helpFor(arguments_), exitCode: CliExitCode.success };
  }
  if (arguments_.includes("--version") || arguments_.includes("-V")) {
    // The plain form stays the user-facing release version; --json adds the
    // immutable build identity so two installs of the same release can be
    // told apart by the sources that produced them.
    const text = arguments_.includes("--json")
      ? JSON.stringify(buildIdentity)
      : programVersion;
    return { _tag: "Version", text, exitCode: CliExitCode.success };
  }
  return undefined;
};
