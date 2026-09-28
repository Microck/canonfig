import { buildIdentity } from "../runtime/build-identity.ts";
import { CliExitCode } from "./exit-codes.ts";

// This module and its imports load no Effect and no command graph: the
// entrypoint answers help and --version from here before importing anything
// heavy, which is most of what a CLI start used to cost.

export const programName = "canonfig";
export const programDisplayName = "Canonfig";
export const programVersion = "4.0.0";

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
 * group. Groups dispatched before `evaluateCli` (secrets, harness, installer)
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
    title: "Source Machine",
    areas: ["source"],
    usage: [
      "source init",
      "source scan --file <path> [--file <path>...]",
      "source digest --profile-file <profile.jsonc> [--resource <id>]",
      "source publish --profile-file <profile.jsonc> --reviewer <name> [--proposal <path>] [--allow-empty]",
      "source publish --proposal <path> --profile <id> --name <name> --reviewer <name> [--allow-empty]",
      "source serve [--host <127.0.0.1|::1>] [--port <port>]",
      "source service install [--host <127.0.0.1|::1>] [--port <port>]",
      "source service status",
      "source service remove",
      "source invite --endpoint <https-url> --output <path> [--expires <duration>] [--group <name>...]",
      "  [--timeout-ms <ms>]",
      "source revoke <follower-id>",
    ],
    notes: [
      "scan is tool discovery: it proposes tool resources from evidence in the named",
      "files and never proposes file, config, or skill resources. Author those in a",
      "profile file and publish it with --profile-file.",
      "digest validates a profile and prints each content digest without publishing.",
      "publish refuses a revision with no resources unless --allow-empty is given.",
      "Republishing content equal to the latest revision returns that revision; any",
      "other content, including an older revision's, becomes the next sequence.",
      "service installs a native user service that runs source serve (systemd user",
      "unit, launchd agent, or Task Scheduler at-logon task); serve runs in the foreground.",
      "invite writes a mode-0600 single-use envelope; move it over a private channel.",
    ],
  },
  {
    title: "Follower enrollment",
    areas: ["follower"],
    usage: [
      "follower enroll --stdin --name <name> --profile <id> [--replace] [--timeout-ms <milliseconds>]",
      "follower unenroll",
    ],
    notes: [
      "Pipe the invitation envelope: cat ./canonfig-invite | canonfig follower enroll --stdin ...",
      "The invitation is never accepted as an argument.",
      "--timeout-ms bounds each enrollment network phase (default 10000; maximum 300000).",
      "Enrolling again under the same name with a new invitation rotates the credential and",
      "keeps local settings. --replace enrolls a new identity, revokes the old one, and",
      "lists what it reset (agent policy, harness and secret bindings, schedule, overlays).",
      "unenroll revokes this identity on the Source, deletes its local credential and",
      "received shared secrets, and leaves applied files in place.",
    ],
  },
  {
    title: "Synchronization",
    areas: ["sync"],
    usage: [
      "sync [--plan | --apply] [--no-input]",
    ],
    notes: [
      "--plan (the default) downloads and compares without changing the machine.",
      "--apply journals every action and verifies each resource independently.",
      "--no-input never prompts. Native schedules run: sync --apply --no-input --scheduled",
    ],
  },
  {
    title: "Recovery",
    areas: ["recover", "abandon"],
    usage: [
      "recover [--no-input]",
      "abandon",
    ],
    notes: [
      "recover resumes or rolls back the interrupted run from its journal.",
      "abandon closes a run recover cannot resolve; it does not roll anything back.",
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
    title: "Local overlays",
    areas: ["overlay"],
    usage: [
      "overlay list",
      "overlay set <resource-id> --target <path> --key <config.path> [--key <config.path>...]",
      "overlay remove <resource-id>",
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
      "  [--ssh-executable <path>] [--ssh-argument <arg>...] [--timeout-ms <ms>]",
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
      "profile select <profile-id>",
    ],
  },
  {
    title: "Agent policy",
    areas: ["agent"],
    usage: [
      "agent policy [deterministic-only|agent-propose|agent-apply]",
      "agent harness [codex|claude|gemini] --executable <path> [--allow-path <path>...]",
      "  [--allow-leaf-executable <name>...] [--bind-secret <ENV=secret-name>...]",
      "  [--allow-origin <https-origin>...] [--allow-capability <capability>...]",
      "  [--maximum-input-bytes <bytes>]",
    ],
  },
  {
    title: "Journaled setup",
    areas: ["setup"],
    usage: [
      "setup plan --role <source|follower> [--scope <full|cli-only|project-only>] [--file <path>...]",
      "  [--mode <simple|advanced>] [--intent <text>]",
      "setup approve --approver <name>",
      "setup apply",
      "setup status",
    ],
    notes: [
      "--file bounds tool discovery only. It does not choose which files are synced;",
      "the published profile does. --mode records the interview depth you chose; it",
      "does not change the plan. setup status shows role, scope, mode, discovery paths,",
      "approver, and completed stages.",
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
    title: "Harness configuration (details: canonfig harness --help)",
    areas: ["harness"],
    usage: [
      "harness init [--format yaml|json]",
      "harness validate|targets|plan|apply|status|diff|clean|doctor [--target <id>...] [--strict]",
    ],
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
