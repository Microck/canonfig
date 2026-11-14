import { Effect, Option, Schema } from "effect";
import type { MachineState } from "../machine/machine-state.service.ts";

import {
  CertificateFingerprint,
  FollowerId,
  GroupName,
  InvitationCode,
  ProfileRevisionId,
  Timestamp,
} from "../domain/brand.ts";
import { AgentPolicy } from "../domain/identity.ts";
import type { EnrollmentInvitationGrant } from "../enrollment/enrollment.types.ts";
import { isNestedCommandLauncher } from "../agent/agent-resolution.service.ts";
import { ExecutableAuthorizationSchema } from "../domain/synchronization.ts";
import { parseOverlay } from "../projection/folder.ts";
import { TARGET_IDS, type TargetId } from "../projection/model.ts";
import { NATIVE_PLUGIN_HARNESSES } from "../projection/native-plugin.ts";
import type { ShieldInput } from "./shield.ts";
import {
  scheduleWeekdays,
  type SyncSchedule,
} from "../schedule/schedule-manager.types.ts";
import {
  AgentHarnessCapability,
  type FollowerAgentHarnessConfiguration,
  SupportedAgentHarness,
} from "../synchronization/follower-sync-config.ts";
import {
  CliExitCode,
  exitCodeForFailure,
  type CliExitCode as CliExitCodeValue,
} from "./exit-codes.ts";
import { FollowerCommands } from "./follower-commands.ts";
import {
  renderCliResult,
  renderUsageFailure,
  type CliOutputFormat,
} from "./render.ts";
import {
  CliCommandFailure,
  SourceCommands,
  type CliPayload,
} from "./source-commands.ts";
import { SetupCommands, type SetupImportRequest } from "./setup-commands.ts";
import { helpOrVersion, uiUsage, type HelpOrVersionOutcome } from "./help.ts";
import { BlobTransferProgress } from "../enrollment/blob-transfer-progress.ts";
import { humanTransferProgress } from "./transfer-progress.ts";
import { guiHostProblem, guiOrigin, runGui } from "../gui/server.ts";
import type { ManagedCommandLease } from "../runtime/self-update/coordination.ts";
import type { GuiQueries } from "../gui/queries.ts";
import type { StateRepository } from "../state/state-repository.service.ts";

export type CliCommand =
  | { readonly _tag: "Ui"; readonly port: number; readonly open: boolean; readonly host: string; readonly origin: string | undefined }
  | { readonly _tag: "SourceInit" }
  | {
    readonly _tag: "SourceScan";
    /** Insert the reviewed tool entries into canonfig.jsonc. */
    readonly write: boolean;
  }
  | { readonly _tag: "SourcePublish"; readonly reviewer: string }
  | {
    readonly _tag: "SourceServe";
    readonly hostname: "127.0.0.1" | "::1";
    readonly port: number;
  }
  | {
    readonly _tag: "SourceServiceInstall";
    readonly hostname: "127.0.0.1" | "::1";
    readonly port: number;
  }
  | { readonly _tag: "SourceServiceStatus" }
  | { readonly _tag: "SourceServiceRemove" }
  | {
    readonly _tag: "SourceInvite";
    readonly endpoint: string;
    readonly expiresInMilliseconds: number;
    readonly groups: ReadonlyArray<typeof GroupName.Type>;
    readonly outputPath: string;
    readonly timeoutMilliseconds: number;
  }
  | { readonly _tag: "SourceRevoke"; readonly follower: typeof FollowerId.Type }
  | {
    readonly _tag: "FollowerEnroll";
    readonly invitation: EnrollmentInvitationGrant;
    readonly followerName: string;
    readonly timeoutMilliseconds?: number | undefined;
    /** Replace a completed enrollment instead of refusing. */
    readonly replace: boolean;
  }
  | { readonly _tag: "FollowerUnenroll" }
  | {
    readonly _tag: "Synchronize";
    readonly mode: "plan" | "apply";
    readonly noInput: boolean;
    /** Only the rendered native job passes this; it keys the fire evidence. */
    readonly scheduled: boolean;
    /** Take over harness surfaces without a takeover snapshot. */
    readonly noBackup: boolean;
    /** With `--plan`: write private append-local adoption reviews. */
    readonly reviewLocal: boolean;
  }
  | { readonly _tag: "Shield"; readonly input: ShieldInput }
  | { readonly _tag: "Restore"; readonly snapshot?: string | undefined }
  | {
    readonly _tag: "Export";
    readonly output?: string | undefined;
    readonly includeHarnesses: boolean;
    readonly force: boolean;
  }
  | {
    readonly _tag: "Import";
    readonly archive: string;
    readonly dryRun: boolean;
    readonly replace: boolean;
    readonly expectKey: string | undefined;
  }
  | {
    readonly _tag: "Harnesses";
    readonly change?: { readonly action: "include" | "exclude"; readonly harness: TargetId } | undefined;
  }
  | {
    readonly _tag: "Overlays";
    readonly change?: { readonly action: "set" | "remove"; readonly item: string } | undefined;
  }
  | { readonly _tag: "Recover"; readonly noInput: boolean }
  | { readonly _tag: "Abandon" }
  | { readonly _tag: "Status"; readonly follower?: typeof FollowerId.Type | undefined }
  | {
    readonly _tag: "Doctor";
    readonly noInput: boolean;
    readonly timeoutMilliseconds: number;
  }
  | {
    readonly _tag: "TunnelStart";
    readonly invitationPath: string;
    readonly sshHost: string;
    readonly sshPort: number;
    readonly sshUser: string;
    readonly sshHostKeyPath: string;
    readonly localHost: "127.0.0.1" | "::1";
    readonly localPort: number;
    readonly sshExecutable?: string | undefined;
    readonly sshArguments: ReadonlyArray<string>;
    readonly timeoutMilliseconds: number;
  }
  | {
    /** `tunnel start` without `--invitation`: restart from the recorded configuration. */
    readonly _tag: "TunnelRestart";
    readonly timeoutMilliseconds?: number | undefined;
  }
  | { readonly _tag: "TunnelStatus" }
  | { readonly _tag: "TunnelStop"; readonly forget: boolean }
  | {
    readonly _tag: "SetupPlan";
    readonly role: string;
    readonly scope?: string | undefined;
    readonly mode?: string | undefined;
    readonly files: ReadonlyArray<string>;
    readonly intent?: string | undefined;
    /** `--harness` values; undefined keeps the detected or already listed harnesses. */
    readonly harnesses?: ReadonlyArray<string> | undefined;
    readonly imports: SetupImportRequest;
  }
  | { readonly _tag: "SetupApprove"; readonly approver: string }
  | { readonly _tag: "SetupApply" }
  | { readonly _tag: "SetupStatus" }
  | { readonly _tag: "ProfileList" }
  | {
    readonly _tag: "ProfileShow";
    readonly revision: typeof ProfileRevisionId.Type;
  }
  | { readonly _tag: "AgentPolicyGet" }
  | { readonly _tag: "AgentPolicySet"; readonly policy: typeof AgentPolicy.Type }
  | { readonly _tag: "AgentHarnessGet" }
  | {
    readonly _tag: "AgentHarnessSet";
    readonly configuration: FollowerAgentHarnessConfiguration;
  }
  | {
    readonly _tag: "ScheduleSet";
    readonly schedule: SyncSchedule;
    readonly executable?: string | undefined;
  }
  | { readonly _tag: "ScheduleSetDefault" }
  | { readonly _tag: "ScheduleStatus" }
  | { readonly _tag: "ScheduleRemove" };

export type CliOutcome =
  | HelpOrVersionOutcome
  | {
    readonly _tag: "Command";
    readonly command: CliCommand;
    readonly format: CliOutputFormat;
    readonly exitCode: CliExitCodeValue;
  }
  | {
    readonly _tag: "InvalidInput";
    readonly message: string;
    readonly format: CliOutputFormat;
    readonly exitCode: CliExitCodeValue;
  };

export interface CliIo {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly setExitCode: (exitCode: CliExitCodeValue) => void;
}

interface Options {
  readonly positionals: ReadonlyArray<string>;
  readonly values: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly switches: ReadonlySet<string>;
}

const invalid = (message: string): CliOutcome => ({
  _tag: "InvalidInput",
  message,
  // Overwritten by evaluateCli, which is where the requested format is known.
  format: "human",
  exitCode: CliExitCode.usageOrConfiguration,
});

const command = (
  value: CliCommand,
  format: CliOutputFormat,
): CliOutcome => ({
  _tag: "Command",
  command: value,
  format,
  exitCode: CliExitCode.success,
});

const parseOptions = (
  arguments_: ReadonlyArray<string>,
  valueOptions: ReadonlySet<string>,
  switchOptions: ReadonlySet<string>,
  literalValueOption?: string,
): Options => {
  const positionals: Array<string> = [];
  const values = new Map<string, Array<string>>();
  const switches = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!argument.startsWith("-")) {
      positionals.push(argument);
      continue;
    }
    if (switchOptions.has(argument)) {
      if (switches.has(argument)) {
        throw new Error(`Option may be specified only once: ${argument}`);
      }
      switches.add(argument);
      continue;
    }
    if (!valueOptions.has(argument)) throw new Error(`Unknown option: ${argument}`);
    const value = arguments_[index + 1];
    if (value === undefined || (value.startsWith("-") && argument !== literalValueOption)) {
      throw new Error(`Option requires a value: ${argument}`);
    }
    index += 1;
    const entries = values.get(argument) ?? [];
    entries.push(value);
    values.set(argument, entries);
  }
  return { positionals, values, switches };
};

const one = (
  options: Options,
  name: string,
  required = false,
): string | undefined => {
  const entries = options.values.get(name) ?? [];
  if (entries.length > 1) throw new Error(`Option may be specified only once: ${name}`);
  const value = entries[0];
  if (required && value === undefined) throw new Error(`Missing required option: ${name}`);
  return value;
};

const decodeOption = <Value>(
  decoder: (input: string) => Option.Option<Value>,
  value: string,
  label: string,
): Value => {
  const decoded = decoder(value);
  if (Option.isNone(decoded)) throw new Error(`Invalid ${label}: ${value}`);
  return decoded.value;
};

const parsePositiveInteger = (
  value: string,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (!/^[1-9]\d*$/u.test(value)) throw new Error(`Invalid ${label}: ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return number;
};

interface ParsedSecretBinding {
  readonly name: string;
  readonly secret: string;
}

const parseSecretBinding = (
  value: string,
): ParsedSecretBinding => {
  const separator = value.indexOf("=");
  const name = separator < 0 ? "" : value.slice(0, separator);
  const secret = separator < 0 ? "" : value.slice(separator + 1);
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(secret)
  ) {
    throw new Error("Invalid secret binding; expected ENV_NAME=shared-secret-name");
  }
  return { name, secret };
};

const durationMilliseconds = (value: string): number => {
  const match = /^(?<amount>[1-9]\d*)(?<unit>ms|s|m|h)$/u.exec(value);
  if (match?.groups === undefined) throw new Error(`Invalid duration: ${value}`);
  const amount = parsePositiveInteger(match.groups.amount ?? "", "duration");
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
    match.groups.unit ?? ""
  ];
  if (multiplier === undefined || amount * multiplier > 86_400_000) {
    throw new Error("Invitation duration must not exceed 24h");
  }
  return amount * multiplier;
};

const invitationSchema = Schema.Struct({
  code: InvitationCode,
  nonce: Schema.NonEmptyString,
  endpoint: Schema.NonEmptyString,
  sourceFingerprint: CertificateFingerprint,
  tlsFingerprint: CertificateFingerprint,
  groups: Schema.Array(GroupName),
  expiresAt: Timestamp,
});

const decodeInvitation = (encoded: string): EnrollmentInvitationGrant => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid enrollment invitation");
  }
  const decoded = Schema.decodeUnknownOption(invitationSchema)(parsed);
  if (Option.isNone(decoded)) throw new Error("Invalid enrollment invitation");
  return decoded.value;
};

const parseSchedule = (
  calendar: string,
  timezone: string | undefined,
): SyncSchedule => {
  const daily = /^daily@(?<time>(?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(calendar);
  if (daily?.groups?.time !== undefined) {
    const schedule: SyncSchedule = {
      kind: "daily",
      localTime: daily.groups.time,
    };
    return timezone === undefined ? schedule : { ...schedule, timezone };
  }
  const weekly = /^weekly:(?<days>(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:,(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*)@(?<time>(?:[01]\d|2[0-3]):[0-5]\d)$/u.exec(
    calendar,
  );
  const days = weekly?.groups?.days?.split(",");
  const localTime = weekly?.groups?.time;
  const decodedWeekdays = days?.map((day) =>
    decodeOption(
      Schema.decodeUnknownOption(Schema.Literals(scheduleWeekdays)),
      day,
      "schedule weekday",
    )
  );
  if (decodedWeekdays !== undefined && localTime !== undefined) {
    const schedule: SyncSchedule = {
      kind: "weekly",
      weekdays: [...new Set(decodedWeekdays)].sort(
        (left, right) => scheduleWeekdays.indexOf(left) - scheduleWeekdays.indexOf(right),
      ),
      localTime,
    };
    return timezone === undefined ? schedule : { ...schedule, timezone };
  }
  throw new Error(`Invalid schedule calendar: ${calendar}`);
};

/** Parses the `schedule` command area. Extracted to keep evaluateCommand simple. */
const evaluateScheduleCommand = (
  action: string | undefined,
  rest: ReadonlyArray<string>,
  format: CliOutputFormat,
): CliOutcome => {
      // Separate options from positionals before judging the argument count, so
      // a stray argument is reported as the stray argument rather than making
      // the action itself look unknown.
      if (action === "status" || action === "remove") {
        const options = parseOptions(rest, new Set(), new Set());
        if (options.positionals.length > 0) {
          return invalid(`canonfig schedule ${action} accepts no arguments`);
        }
        return command(
          { _tag: action === "status" ? "ScheduleStatus" : "ScheduleRemove" },
          format,
        );
      }
      if (action === "set") {
        const options = parseOptions(
          rest,
          new Set(["--timezone", "--executable"]),
          new Set(["--default"]),
        );
        if (options.switches.has("--default")) {
          if (options.positionals.length > 0 || options.values.size > 0) {
            return invalid(
              "canonfig schedule set --default takes no calendar, --timezone, or --executable: it installs the selected profile's scheduleDefault in this machine's time zone",
            );
          }
          return command({ _tag: "ScheduleSetDefault" }, format);
        }
        if (options.positionals.length !== 1) {
          return invalid("Usage: canonfig schedule set <calendar> | canonfig schedule set --default");
        }
        const executable = one(options, "--executable");
        const parsed: CliCommand = {
          _tag: "ScheduleSet",
          schedule: parseSchedule(options.positionals[0]!, one(options, "--timezone")),
        };
        return command(
          executable === undefined ? parsed : { ...parsed, executable },
          format,
        );
      }
      return invalid(`Unknown schedule command: ${action ?? ""}`);
};

const evaluateTunnelCommand = (
  action: string | undefined,
  rest: ReadonlyArray<string>,
  format: CliOutputFormat,
): CliOutcome => {
  if (action === "status") {
    const options = parseOptions(rest, new Set(), new Set());
    if (options.positionals.length > 0) return invalid("canonfig tunnel status accepts no arguments");
    return command({ _tag: "TunnelStatus" }, format);
  }
  if (action === "stop") {
    const options = parseOptions(rest, new Set(), new Set(["--forget"]));
    if (options.positionals.length > 0) return invalid("tunnel stop accepts only --forget");
    return command({ _tag: "TunnelStop", forget: options.switches.has("--forget") }, format);
  }
  if (action !== "start") return invalid(`Unknown tunnel command: ${action ?? ""}`);
  const options = parseOptions(
    rest,
    new Set([
      "--invitation",
      "--ssh-host",
      "--ssh-port",
      "--ssh-user",
      "--ssh-host-key-file",
      "--local-host",
      "--local-port",
      "--ssh-executable",
      "--ssh-argument",
      "--timeout-ms",
    ]),
    new Set(),
    "--ssh-argument",
  );
  if (options.positionals.length > 0) {
    return invalid("tunnel start accepts only named options");
  }
  if (one(options, "--invitation") === undefined) {
    const configurationOptions = [...options.values.keys()].filter((name) =>
      name !== "--timeout-ms"
    );
    if (configurationOptions.length > 0) {
      return invalid(
        `tunnel start without --invitation restarts the recorded tunnel and accepts only --timeout-ms; pass --invitation to configure a new tunnel (got ${configurationOptions.join(", ")})`,
      );
    }
    const timeout = one(options, "--timeout-ms");
    return command({
      _tag: "TunnelRestart",
      timeoutMilliseconds: timeout === undefined
        ? undefined
        : parsePositiveInteger(timeout, "tunnel timeout", 300_000),
    }, format);
  }
  const localHost = one(options, "--local-host") ?? "127.0.0.1";
  if (localHost !== "127.0.0.1" && localHost !== "::1") {
    return invalid(`Invalid tunnel local host: ${localHost}`);
  }
  return command({
    _tag: "TunnelStart",
    invitationPath: one(options, "--invitation", true)!,
    sshHost: one(options, "--ssh-host", true)!,
    sshPort: parsePositiveInteger(
      one(options, "--ssh-port") ?? "22",
      "SSH port",
      65_535,
    ),
    sshUser: one(options, "--ssh-user", true)!,
    sshHostKeyPath: one(options, "--ssh-host-key-file", true)!,
    localHost,
    localPort: parsePositiveInteger(
      one(options, "--local-port") ?? "17342",
      "tunnel local port",
      65_535,
    ),
    sshExecutable: one(options, "--ssh-executable"),
    sshArguments: options.values.get("--ssh-argument") ?? [],
    timeoutMilliseconds: parsePositiveInteger(
      one(options, "--timeout-ms") ?? "30000",
      "tunnel timeout",
      300_000,
    ),
  }, format);
};
const evaluateSetupCommand = (
  action: string | undefined,
  rest: ReadonlyArray<string>,
  format: CliOutputFormat,
): CliOutcome => {
  if (action === "apply" || action === "status") {
    const options = parseOptions(rest, new Set(), new Set());
    if (options.positionals.length > 0) {
      return invalid(`setup ${action} accepts no arguments`);
    }
    return command({
      _tag: action === "apply" ? "SetupApply" : "SetupStatus",
    }, format);
  }
  if (action === "approve") {
    const options = parseOptions(rest, new Set(["--approver"]), new Set());
    if (options.positionals.length > 0) {
      return invalid("setup approve accepts only named options");
    }
    return command({
      _tag: "SetupApprove",
      approver: one(options, "--approver", true)!,
    }, format);
  }
  if (action === "plan") {
    const options = parseOptions(
      rest,
      new Set(["--role", "--scope", "--mode", "--file", "--intent", "--harness", "--import"]),
      new Set(["--import-all", "--no-import"]),
    );
    if (options.positionals.length > 0) {
      return invalid("setup plan accepts only named options");
    }
    const imports = options.values.get("--import") ?? [];
    const importModes = [imports.length > 0, options.switches.has("--import-all"), options.switches.has("--no-import")];
    if (importModes.filter(Boolean).length > 1) {
      return invalid("--import, --import-all and --no-import are mutually exclusive");
    }
    return command({
      _tag: "SetupPlan",
      role: one(options, "--role", true)!,
      scope: one(options, "--scope") ?? "full",
      mode: one(options, "--mode"),
      files: options.values.get("--file") ?? [],
      intent: one(options, "--intent"),
      harnesses: options.values.get("--harness"),
      imports: options.switches.has("--no-import")
        ? { kind: "none" }
        : options.switches.has("--import-all")
        ? { kind: "all" }
        : imports.length > 0
        ? { kind: "some", requested: imports }
        : { kind: "offer" },
    }, format);
  }
  return invalid(`Unknown setup command: ${action ?? ""}`);
};

const evaluateSourceCommand = (
  action: string | undefined,
  rest: ReadonlyArray<string>,
  format: CliOutputFormat,
): CliOutcome => {
  if (action === "init") {
    const options = parseOptions(rest, new Set(), new Set());
    if (options.positionals.length > 0) return invalid("canonfig source init accepts no arguments");
    return command({ _tag: "SourceInit" }, format);
  }
  if (action === "scan") {
    const options = parseOptions(rest, new Set(), new Set(["--write"]));
    if (options.positionals.length > 0) return invalid("source scan reads ~/.canonfig/ and accepts only --write");
    return command({ _tag: "SourceScan", write: options.switches.has("--write") }, format);
  }
  if (action === "publish") {
    const options = parseOptions(rest, new Set(["--reviewer"]), new Set());
    if (options.positionals.length > 0) return invalid("source publish accepts only --reviewer");
    return command({ _tag: "SourcePublish", reviewer: one(options, "--reviewer", true)! }, format);
  }
  if (action === "serve") {
    const options = parseOptions(rest, new Set(["--host", "--port"]), new Set());
    if (options.positionals.length > 0) return invalid("source serve accepts only named options");
    const hostname = one(options, "--host") ?? "127.0.0.1";
    if (hostname !== "127.0.0.1" && hostname !== "::1") {
      return invalid(`Invalid source host: ${hostname}`);
    }
    const port = parsePositiveInteger(one(options, "--port") ?? "17342", "port", 65_535);
    return command({ _tag: "SourceServe", hostname, port }, format);
  }
  if (action === "service") {
    const [serviceAction, ...serviceArguments] = rest;
    if (serviceAction === "install") {
      const options = parseOptions(serviceArguments, new Set(["--host", "--port"]), new Set());
      if (options.positionals.length > 0) {
        return invalid("source service install accepts only --host and --port");
      }
      const hostname = one(options, "--host") ?? "127.0.0.1";
      if (hostname !== "127.0.0.1" && hostname !== "::1") {
        return invalid(`Invalid source host: ${hostname}`);
      }
      const port = parsePositiveInteger(one(options, "--port") ?? "17342", "port", 65_535);
      return command({ _tag: "SourceServiceInstall", hostname, port }, format);
    }
    if (serviceAction === "status" || serviceAction === "remove") {
      if (serviceArguments.length > 0) {
        return invalid(`source service ${serviceAction} accepts no arguments`);
      }
      return command({
        _tag: serviceAction === "status" ? "SourceServiceStatus" : "SourceServiceRemove",
      }, format);
    }
    return invalid(`Unknown source service command: ${serviceAction ?? ""}`);
  }
  if (action === "invite") {
    const options = parseOptions(
      rest,
      new Set(["--endpoint", "--expires", "--group", "--output", "--timeout-ms"]),
      new Set(),
    );
    if (options.positionals.length > 0) return invalid("source invite accepts only named options");
    const endpoint = one(options, "--endpoint", true)!;
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return invalid(`Invalid source endpoint: ${endpoint}`);
    }
    if (url.protocol !== "https:") return invalid("Source endpoint must use HTTPS");
    if (
      url.hostname !== "127.0.0.1"
      && url.hostname !== "[::1]"
      && url.hostname !== "::1"
    ) {
      return invalid("Source endpoint must use a loopback host");
    }
    const groups = (options.values.get("--group") ?? []).map((value) =>
      decodeOption(Schema.decodeUnknownOption(GroupName), value, "group name")
    );
    return command({
      _tag: "SourceInvite",
      endpoint: url.origin,
      expiresInMilliseconds: durationMilliseconds(one(options, "--expires") ?? "15m"),
      outputPath: one(options, "--output", true)!,
      timeoutMilliseconds: parsePositiveInteger(
        one(options, "--timeout-ms") ?? "10000",
        "invitation delivery timeout",
        60_000,
      ),
      groups,
    }, format);
  }
  if (action === "revoke") {
    const options = parseOptions(rest, new Set(), new Set());
    if (options.positionals.length !== 1) return invalid("Usage: canonfig source revoke <follower-id>");
    return command({
      _tag: "SourceRevoke",
      follower: decodeOption(Schema.decodeUnknownOption(FollowerId), options.positionals[0]!, "follower id"),
    }, format);
  }
  return invalid(`Unknown source command: ${action ?? ""}`);
};

const evaluateProfileCommand = (
  action: string | undefined,
  rest: ReadonlyArray<string>,
  format: CliOutputFormat,
): CliOutcome => {
  if (action === "list") {
    const options = parseOptions(rest, new Set(), new Set());
    if (options.positionals.length > 0) return invalid("canonfig profile list accepts no arguments");
    return command({ _tag: "ProfileList" }, format);
  }
  if (action === "show") {
    const options = parseOptions(rest, new Set(), new Set());
    if (options.positionals.length !== 1) return invalid("Usage: canonfig profile show <revision-id>");
    return command({
      _tag: "ProfileShow",
      revision: decodeOption(Schema.decodeUnknownOption(ProfileRevisionId), options.positionals[0]!, "profile revision id"),
    }, format);
  }
  return invalid(`Unknown profile command: ${action ?? ""}`);
};


const evaluateAgentHarnessCommand = (
  rest: ReadonlyArray<string>,
  format: CliOutputFormat,
): CliOutcome => {
  if (rest.length === 0) return command({ _tag: "AgentHarnessGet" }, format);
  const [kind, ...harnessArguments] = rest;
  // `--argument` takes values that look like flags (`--argument --json`), so it is the literal option.
  const options = parseOptions(
    harnessArguments,
    new Set([
      "--executable",
      "--model",
      "--argument",
      "--allow-path",
      "--allow-leaf-executable",
      "--bind-secret",
      "--allow-origin",
      "--allow-capability",
      "--maximum-input-bytes",
    ]),
    new Set(),
    "--argument",
  );
  if (options.positionals.length > 0) {
    return invalid("agent harness accepts one adapter kind and named options");
  }
  // Built-ins own their flags and only take a model; a custom harness owns its whole command line.
  const model = one(options, "--model");
  const customArguments = options.values.get("--argument");
  if (kind === "custom" && model !== undefined) {
    return invalid("--model applies to codex and claude; pass a custom harness's model with --argument");
  }
  if (kind !== "custom" && customArguments !== undefined) {
    return invalid("--argument applies only to the custom harness; codex and claude get Canonfig's read-only flags");
  }
  const origins = options.values.get("--allow-origin") ?? [];
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return invalid(`Invalid agent harness origin: ${origin}`);
    }
    if (url.protocol !== "https:" || url.origin !== origin) {
      return invalid(`Agent harness origin must be an exact HTTPS origin: ${origin}`);
    }
  }
  const configuration = Schema.decodeUnknownOption(
    Schema.Struct({
      kind: SupportedAgentHarness,
      executable: Schema.NonEmptyString,
      model: Schema.optional(Schema.NonEmptyString.check(Schema.isPattern(/^[^\s-][^\s]*$/u))),
      arguments: Schema.optional(Schema.Array(Schema.String)),
      maximumInputBytes: Schema.Int.check(
        Schema.isGreaterThan(0),
        Schema.isLessThanOrEqualTo(1024 * 1024),
      ),
      allowedPaths: Schema.Array(Schema.NonEmptyString),
      allowedExecutables: Schema.Array(Schema.NonEmptyString),
      executableAuthorizations: Schema.Array(ExecutableAuthorizationSchema),
      secretBindings: Schema.Array(Schema.Struct({
        name: Schema.NonEmptyString,
        secret: Schema.NonEmptyString,
      })),
      allowedOrigins: Schema.Array(Schema.NonEmptyString),
      allowedCapabilities: Schema.Array(AgentHarnessCapability),
    }),
  )({
    kind,
    executable: one(options, "--executable", true),
    model,
    arguments: customArguments,
    maximumInputBytes: parsePositiveInteger(
      one(options, "--maximum-input-bytes") ?? `${1024 * 1024}`,
      "agent harness maximum input bytes",
      1024 * 1024,
    ),
    allowedPaths: options.values.get("--allow-path") ?? [],
    allowedExecutables: [
      ...new Set(options.values.get("--allow-leaf-executable") ?? []),
    ],
    secretBindings: (options.values.get("--bind-secret") ?? [])
      .map(parseSecretBinding),
    executableAuthorizations: (options.values.get("--allow-leaf-executable") ?? [])
      .map((executable) => ({ executable, behavior: "leaf" as const })),
    allowedOrigins: origins,
    allowedCapabilities: options.values.get("--allow-capability") ?? [],
  });
  if (Option.isNone(configuration)) {
    return invalid("Invalid agent harness configuration");
  }
  const unclassifiable = configuration.value.executableAuthorizations.find(
    (authorization) => isNestedCommandLauncher(authorization.executable),
  );
  if (unclassifiable !== undefined) {
    return invalid(
      `${unclassifiable.executable} launches nested commands that cannot be bounded by an execution model; remove it from the agent harness allowlist`,
    );
  }
  return command({
    _tag: "AgentHarnessSet",
    configuration: configuration.value,
  }, format);
};

const evaluateShieldCommand = (action: string | undefined, rest: ReadonlyArray<string>, format: CliOutputFormat): CliOutcome => {
  if (action === "install" || action === "run") {
    const [separator, executable, ...args] = rest;
    if (separator !== "--" || executable === undefined || executable.length === 0) return invalid(`Usage: canonfig shield ${action} -- <command> [arguments...]`);
    return command({ _tag: "Shield", input: { action, argv: [executable, ...args] } }, format);
  }
  const options = parseOptions(rest, new Set(action === "review" ? ["--digest", "--reviewer"] : action === "add-plugin" ? ["--harness", "--entry"] : []), new Set(action === "enable" ? ["--hard"] : []));
  if (action === "status" || action === "disable" || action === "ingest" || action === "enable") {
    if (options.positionals.length !== 0) return invalid(`shield ${action} accepts no positional arguments`);
    return command({ _tag: "Shield", input: action === "enable" ? { action, hard: options.switches.has("--hard") } : { action } }, format);
  }
  const [id] = options.positionals;
  if (options.positionals.length !== 1 || id === undefined) return invalid("Use canonfig shield --help for commands and required arguments");
  if (action === "add-plugin") {
    const harness = NATIVE_PLUGIN_HARNESSES.find((candidate) => candidate === one(options, "--harness", true));
    if (harness === undefined) return invalid(`Native plugin harness must be one of ${NATIVE_PLUGIN_HARNESSES.join(", ")}`);
    return command({ _tag: "Shield", input: { action, directory: id, harness, entry: one(options, "--entry") } }, format);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) return invalid("Plugin id must use lowercase letters, digits and hyphens");
  if (action === "include" || action === "exclude") return command({ _tag: "Shield", input: { action, id } }, format);
  if (action === "review") {
    const digest = one(options, "--digest", true)!;
    const reviewer = one(options, "--reviewer", true)!;
    if (!/^[a-f0-9]{64}$/u.test(digest) || reviewer.trim().length === 0) return invalid("Review requires a SHA-256 digest and a nonempty reviewer name");
    return command({ _tag: "Shield", input: { action, id, digest, reviewer } }, format);
  }
  return invalid("Unknown Shield command; use canonfig shield --help");
};

const evaluateCommand = (
  arguments_: ReadonlyArray<string>,
  format: CliOutputFormat,
): CliOutcome => {
  const [area, action, ...rest] = arguments_;
  try {
    const groups = new Set(["source", "follower", "profile", "overlay", "tunnel", "setup", "agent", "schedule"]);
    if (area !== undefined && groups.has(area) && action === undefined) {
      return invalid(`Missing ${area} command`);
    }
    if (area === "ui") {
      const options = parseOptions(arguments_.slice(1), new Set(["--port", "--host", "--origin"]), new Set(["--no-open"]));
      if (options.positionals.length > 0) return invalid(`Usage: canonfig ${uiUsage}`);
      if (format === "json") return invalid("canonfig ui prints a browser sign-in URL and does not support --json");
      const port = one(options, "--port");
      const host = one(options, "--host") ?? "127.0.0.1";
      const hostProblem = guiHostProblem(host);
      if (hostProblem !== undefined) return invalid(hostProblem);
      const originValue = one(options, "--origin");
      const origin = originValue === undefined ? undefined : guiOrigin(originValue);
      if (origin !== undefined && "problem" in origin) return invalid(origin.problem);
      // A proxy forwards to one fixed address, so a random port would leave it nothing to reach.
      if (origin !== undefined && port === undefined) return invalid("--origin needs --port, the port your proxy forwards to");
      return command({
        _tag: "Ui",
        port: port === undefined ? 0 : parsePositiveInteger(port, "browser port", 65_535),
        open: !options.switches.has("--no-open"),
        host,
        origin: origin?.origin,
      }, format);
    }
    if (area === "shield") return evaluateShieldCommand(action, rest, format);
    if (area === "source") return evaluateSourceCommand(action, rest, format);
    // The positional invitation below serves the private `--stdin`
    // redispatch built in main.ts from in-memory argv. Real process argv
    // carrying a positional invitation is refused there before parsing.
    if (area === "follower" && action === "enroll") {
      const options = parseOptions(
        rest,
        new Set(["--name", "--timeout-ms"]),
        new Set(["--replace"]),
      );
      if (options.positionals.length !== 1) {
        return invalid(
          "Usage: canonfig follower enroll <invite> --name <name> [--timeout-ms <milliseconds>]",
        );
      }
      const timeout = one(options, "--timeout-ms");
      return command({
        _tag: "FollowerEnroll",
        invitation: decodeInvitation(options.positionals[0]!),
        followerName: one(options, "--name", true)!,
        replace: options.switches.has("--replace"),
        timeoutMilliseconds: timeout === undefined
          ? undefined
          : parsePositiveInteger(timeout, "enrollment timeout", 300_000),
      }, format);
    }
    if (area === "follower" && action === "unenroll") {
      const options = parseOptions(rest, new Set(), new Set());
      if (options.positionals.length > 0) return invalid("follower unenroll accepts no arguments");
      return command({ _tag: "FollowerUnenroll" }, format);
    }
    if (area === "profile") return evaluateProfileCommand(action, rest, format);
    if (area === "sync") {
      const options = parseOptions(
        arguments_.slice(1),
        new Set(),
        // --scheduled is set by the rendered native job; typing it by hand
        // is harmless but pointless without the scheduler's provenance.
        new Set(["--plan", "--apply", "--no-input", "--scheduled", "--no-backup", "--review-local"]),
      );
      if (options.positionals.length > 0) return invalid("sync accepts no positional arguments");
      if (options.switches.has("--plan") && options.switches.has("--apply")) {
        return invalid("--plan and --apply are mutually exclusive");
      }
      // Reviews hold exact local text for a person to read before applying.
      if (options.switches.has("--review-local")
        && (options.switches.has("--apply") || options.switches.has("--scheduled") || options.switches.has("--no-input"))) {
        return invalid("--review-local requires an interactive --plan, not --apply, --scheduled, or --no-input");
      }
      return command({
        _tag: "Synchronize",
        mode: options.switches.has("--apply") ? "apply" : "plan",
        noInput: options.switches.has("--no-input"),
        scheduled: options.switches.has("--scheduled"),
        noBackup: options.switches.has("--no-backup"),
        reviewLocal: options.switches.has("--review-local"),
      }, format);
    }
    if (area === "overlay") {
      const options = parseOptions(rest, new Set(), new Set());
      const [item, ...extra] = options.positionals;
      if (action === "list" && item === undefined) return command({ _tag: "Overlays" }, format);
      if ((action !== "set" && action !== "remove") || item === undefined || extra.length > 0) {
        return invalid("Usage: canonfig overlay list | canonfig overlay set|remove <category>/<name> | canonfig overlay set|remove settings/<harness>#<key>");
      }
      const parsed = parseOverlay(item);
      if (parsed.kind === "invalid") return invalid(parsed.reason);
      return command({ _tag: "Overlays", change: { action, item } }, format);
    }
    if (area === "restore") {
      const options = parseOptions(arguments_.slice(1), new Set(), new Set());
      if (options.positionals.length > 1) return invalid("Usage: canonfig restore [<snapshot>]");
      return command({ _tag: "Restore", snapshot: options.positionals[0] }, format);
    }
    if (area === "export") {
      const options = parseOptions(arguments_.slice(1), new Set(["--output"]), new Set(["--include-harnesses", "--force"]));
      if (options.positionals.length > 0) {
        return invalid("Usage: canonfig export [--output <file.tar.gz>] [--include-harnesses] [--force]");
      }
      return command({
        _tag: "Export",
        output: one(options, "--output"),
        includeHarnesses: options.switches.has("--include-harnesses"),
        force: options.switches.has("--force"),
      }, format);
    }
    if (area === "import") {
      const options = parseOptions(arguments_.slice(1), new Set(["--expect-key"]), new Set(["--dry-run", "--replace"]));
      const usage = "Usage: canonfig import <file.tar.gz> [--dry-run] [--replace] [--expect-key <fingerprint>]";
      if (options.positionals.length !== 1) return invalid(usage);
      // The fingerprint `canonfig status` shows on the Source: SHA-256 hex.
      const expectKey = one(options, "--expect-key")?.toLowerCase();
      if (expectKey !== undefined && !/^[0-9a-f]{64}$/u.test(expectKey)) {
        return invalid(`--expect-key takes the Source's signing key fingerprint, 64 hex digits as 'canonfig status' shows it on the Source. ${usage}`);
      }
      return command({
        _tag: "Import",
        archive: options.positionals[0]!,
        dryRun: options.switches.has("--dry-run"),
        replace: options.switches.has("--replace"),
        expectKey,
      }, format);
    }
    if (area === "harnesses") {
      const options = parseOptions(arguments_.slice(1), new Set(), new Set());
      const [action, harness, ...extra] = options.positionals;
      if (action === undefined) return command({ _tag: "Harnesses" }, format);
      if ((action !== "include" && action !== "exclude") || harness === undefined || extra.length > 0) {
        return invalid("Usage: canonfig harnesses [include|exclude <harness>]");
      }
      const target = TARGET_IDS.find((id) => id === harness);
      if (target === undefined) return invalid(`Unknown harness: ${harness}; expected one of ${TARGET_IDS.join(", ")}`);
      return command({ _tag: "Harnesses", change: { action, harness: target } }, format);
    }
    if (area === "abandon") {
      const options = parseOptions(arguments_.slice(1), new Set(), new Set());
      if (options.positionals.length > 0) {
        return invalid("abandon accepts no arguments");
      }
      return command({ _tag: "Abandon" }, format);
    }
    if (area === "recover") {
      const options = parseOptions(arguments_.slice(1), new Set(), new Set(["--no-input"]));
      if (options.positionals.length > 0) return invalid("recover accepts no positional arguments");
      return command({ _tag: "Recover", noInput: options.switches.has("--no-input") }, format);
    }
    if (area === "status") {
      const options = parseOptions(arguments_.slice(1), new Set(["--follower"]), new Set());
      if (options.positionals.length > 0) return invalid("status accepts no positional arguments");
      const follower = one(options, "--follower");
      if (follower === undefined) return command({ _tag: "Status" }, format);
      return command({
        _tag: "Status",
        follower: decodeOption(
          Schema.decodeUnknownOption(FollowerId),
          follower,
          "follower id",
        ),
      }, format);
    }
    if (area === "tunnel") return evaluateTunnelCommand(action, rest, format);
    if (area === "setup") return evaluateSetupCommand(action, rest, format);
    if (area === "doctor") {
      const options = parseOptions(
        arguments_.slice(1),
        new Set(["--timeout-ms"]),
        new Set(["--no-input"]),
      );
      if (options.positionals.length > 0) return invalid("doctor accepts no positional arguments");
      return command({
        _tag: "Doctor",
        noInput: options.switches.has("--no-input"),
        timeoutMilliseconds: parsePositiveInteger(
          one(options, "--timeout-ms") ?? "5000",
          "doctor timeout",
          300_000,
        ),
      }, format);
    }
    if (area === "agent" && action === "policy") {
      // Reject unknown options before reading the policy, so an option typo is
      // reported as an unknown option rather than as an invalid policy name.
      const options = parseOptions(rest, new Set(), new Set());
      if (options.positionals.length === 0) return command({ _tag: "AgentPolicyGet" }, format);
      if (options.positionals.length === 1) {
        return command({
          _tag: "AgentPolicySet",
          policy: decodeOption(
            Schema.decodeUnknownOption(AgentPolicy),
            options.positionals[0]!,
            "agent policy",
          ),
        }, format);
      }
      return invalid("Usage: canonfig agent policy [policy]");
    }
    if (area === "agent" && action === "harness") return evaluateAgentHarnessCommand(rest, format);
    if (area === "schedule") {
      return evaluateScheduleCommand(action, rest, format);
    }
    if (area === "agent" || area === "follower") return invalid(`Unknown ${area} command: ${action}`);
    return invalid(`Unknown argument: ${area ?? ""}`);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : "Invalid command input");
  }
};

export const evaluateCli = (arguments_: ReadonlyArray<string>): CliOutcome => {
  const early = helpOrVersion(arguments_);
  if (early !== undefined) return early;
  // Forwarded child arguments are opaque, including its own --json and --help.
  const separator = arguments_.indexOf("--");
  const isOutputFlag = (argument: string, index: number) =>
    argument === "--json" && arguments_[index - 1] !== "--argument" && (separator < 0 || index < separator);
  const format: CliOutputFormat = arguments_.some(isOutputFlag) ? "json" : "human";
  const rest = arguments_.filter((argument, index) => !isOutputFlag(argument, index));
  const outcome = rest.length === 0
    ? invalid("Missing command")
    : evaluateCommand(rest, format);
  return outcome._tag === "InvalidInput" ? { ...outcome, format } : outcome;
};

export const commandName = (value: CliCommand): string => {
  switch (value._tag) {
    case "Ui": return "ui";
    case "SourceInit": return "source.init";
    case "SourceScan": return "source.scan";
    case "SourcePublish": return "source.publish";
    case "SourceServe": return "source.serve";
    case "SourceServiceInstall": return "source.service.install";
    case "SourceServiceStatus": return "source.service.status";
    case "SourceServiceRemove": return "source.service.remove";
    case "SourceInvite": return "source.invite";
    case "SourceRevoke": return "source.revoke";
    case "FollowerEnroll": return "follower.enroll";
    case "FollowerUnenroll": return "follower.unenroll";
    case "Synchronize": return `sync.${value.mode}`;
    case "Shield": return `shield.${value.input.action}`;
    case "Overlays": return value.change === undefined ? "overlay.list" : `overlay.${value.change.action}`;
    case "Restore": return "restore";
    case "Export": return "export";
    case "Import": return value.dryRun ? "import.dry-run" : "import";
    case "Harnesses": return value.change === undefined ? "harnesses" : `harnesses.${value.change.action}`;
    case "Recover": return "recover";
    case "Abandon": return "abandon";
    case "Status": return "status";
    case "Doctor": return "doctor";
    case "ProfileList": return "profile.list";
    case "ProfileShow": return "profile.show";
    case "AgentPolicyGet": return "agent.policy.get";
    case "AgentPolicySet": return "agent.policy.set";
    case "TunnelStart": return "tunnel.start";
    case "TunnelRestart": return "tunnel.start";
    case "TunnelStatus": return "tunnel.status";
    case "TunnelStop": return "tunnel.stop";
    case "SetupPlan": return "setup.plan";
    case "SetupApprove": return "setup.approve";
    case "SetupApply": return "setup.apply";
    case "SetupStatus": return "setup.status";
    case "AgentHarnessGet": return "agent.harness.get";
    case "AgentHarnessSet": return "agent.harness.set";
    case "ScheduleSet":
    case "ScheduleSetDefault": return "schedule.set";
    case "ScheduleStatus": return "schedule.status";
    case "ScheduleRemove": return "schedule.remove";
  }
};

const executeCommand = Effect.fn("Cli.executeCommand")(function*(
  value: Exclude<CliCommand, { readonly _tag: "Ui" }>,
): Effect.fn.Return<
  CliPayload,
  CliCommandFailure,
  SourceCommands | FollowerCommands | SetupCommands
> {
  const source = yield* SourceCommands;
  const follower = yield* FollowerCommands;
  const setup = yield* SetupCommands;
  switch (value._tag) {
    case "SourceInit": return yield* source.initialize();
    case "SourceScan": return yield* source.scan({ write: value.write });
    case "SourcePublish": return yield* source.publish({ reviewer: value.reviewer });
    case "SourceServe":
      return yield* source.serve({ hostname: value.hostname, port: value.port });
    case "SourceServiceInstall":
      return yield* source.installService({ hostname: value.hostname, port: value.port });
    case "SourceServiceStatus": return yield* source.serviceStatus();
    case "SourceServiceRemove": return yield* source.removeService();
    case "SourceInvite":
      return yield* source.invite({
        endpoint: value.endpoint,
        expiresInMilliseconds: value.expiresInMilliseconds,
        groups: value.groups,
        outputPath: value.outputPath,
        timeoutMilliseconds: value.timeoutMilliseconds,
      });
    case "SourceRevoke": return yield* source.revoke(value.follower);
    case "FollowerEnroll":
      return yield* follower.enroll({
        invitation: value.invitation,
        followerName: value.followerName,
        timeoutMilliseconds: value.timeoutMilliseconds,
        replace: value.replace,
      });
    case "FollowerUnenroll": return yield* follower.unenroll();
    case "Synchronize":
      return yield* follower.synchronize({
        mode: value.mode,
        noInput: value.noInput,
        scheduled: value.scheduled,
        noBackup: value.noBackup,
        reviewLocal: value.reviewLocal,
      });
    case "Shield": return yield* follower.shield(value.input);
    case "Overlays": return yield* follower.overlays({ change: value.change });
    case "Restore": return yield* follower.restore({ snapshot: value.snapshot });
    case "Export":
      return yield* follower.exportArchive({
        output: value.output,
        includeHarnesses: value.includeHarnesses,
        force: value.force,
      });
    case "Import":
      return yield* follower.importArchive({ archive: value.archive, dryRun: value.dryRun, replace: value.replace, expectKey: value.expectKey });
    case "Harnesses": return yield* follower.harnesses({ change: value.change });
    case "Recover": return yield* follower.recover({ noInput: value.noInput });
    case "Abandon": return yield* follower.abandon();
    case "Status": return yield* follower.status(value.follower);
    case "Doctor":
      return yield* follower.doctor({
        noInput: value.noInput,
        timeoutMilliseconds: value.timeoutMilliseconds,
      });
    case "TunnelStart": return yield* follower.startTunnel(value);
    case "TunnelRestart":
      return yield* follower.restartTunnel({ timeoutMilliseconds: value.timeoutMilliseconds });
    case "TunnelStatus": return yield* follower.tunnelStatus();
    case "TunnelStop": return yield* follower.stopTunnel({ forget: value.forget });
    case "SetupPlan":
      return yield* setup.plan({
        role: value.role,
        scope: value.scope,
        mode: value.mode,
        files: value.files,
        intent: value.intent,
        harnesses: value.harnesses,
        imports: value.imports,
      });
    case "SetupApprove": return yield* setup.approve({ approver: value.approver });
    case "SetupApply": return yield* setup.apply();
    case "SetupStatus": return yield* setup.status();
    case "ProfileList": return yield* source.listProfiles();
    case "ProfileShow": return yield* source.inspectProfile(value.revision);
    case "AgentPolicyGet": return yield* follower.getAgentPolicy();
    case "AgentPolicySet": return yield* follower.setAgentPolicy(value.policy);
    case "AgentHarnessGet": return yield* follower.getAgentHarness();
    case "AgentHarnessSet":
      return yield* follower.setAgentHarness(value.configuration);
    case "ScheduleSet":
      return yield* follower.setSchedule(
        value.executable === undefined
          ? { schedule: value.schedule }
          : { schedule: value.schedule, executable: value.executable },
      );
    case "ScheduleSetDefault": return yield* follower.setSchedule({ profileDefault: true });
    case "ScheduleStatus": return yield* follower.scheduleStatus();
    case "ScheduleRemove": return yield* follower.removeSchedule();
  }
});

export const runCli = Effect.fn("runCli")(function*(
  arguments_: ReadonlyArray<string>,
  io: CliIo,
  lease?: ManagedCommandLease,
): Effect.fn.Return<
  CliExitCodeValue,
  never,
  SourceCommands | FollowerCommands | SetupCommands | GuiQueries | MachineState | StateRepository
> {
  const outcome = evaluateCli(arguments_);
  if (outcome._tag === "Help" || outcome._tag === "Version") {
    yield* Effect.sync(() => {
      io.writeStdout(`${outcome.text}\n`);
      io.setExitCode(outcome.exitCode);
    });
    return outcome.exitCode;
  }
  if (outcome._tag === "InvalidInput") {
    yield* Effect.sync(() => {
      io.writeStderr(renderUsageFailure(outcome.message, outcome.format));
      io.setExitCode(outcome.exitCode);
    });
    return outcome.exitCode;
  }
  const name = commandName(outcome.command);
  // A person running a human-mode sync or recover sees a long blob download
  // advance on stderr. A scheduled run has nobody watching and stays quiet.
  const showsTransferProgress = outcome.format === "human"
    && (outcome.command._tag === "Recover"
      || (outcome.command._tag === "Synchronize" && outcome.command.scheduled !== true));
  const execution: Effect.Effect<CliPayload, CliCommandFailure, SourceCommands | FollowerCommands | SetupCommands | GuiQueries | MachineState | StateRepository> =
    outcome.command._tag === "Ui" ? runGui(outcome.command, io, lease) : executeCommand(outcome.command);
  const result = yield* (showsTransferProgress
    ? execution.pipe(
      Effect.provideService(BlobTransferProgress, humanTransferProgress(io.writeStderr)),
    )
    : execution).pipe(
    Effect.match({
      onFailure: (failure) => ({
        command: name,
        message: failure.message,
        data: failure.details,
        exitCode: exitCodeForFailure(failure.category),
      }),
      onSuccess: (data) => ({
        command: name,
        message: `${name} completed`,
        data,
        exitCode: CliExitCode.success,
      }),
    }),
  );
  yield* Effect.sync(() => {
    const rendered = renderCliResult(result, outcome.format);
    const quietScheduledSuccess = result.exitCode === CliExitCode.success
      && outcome.format === "human"
      && outcome.command._tag === "Synchronize"
      && outcome.command.mode === "apply"
      && outcome.command.noInput;
    if (quietScheduledSuccess) {
      // Native schedulers need no success chatter; failures remain visible.
    } else if (result.exitCode === CliExitCode.success) io.writeStdout(rendered);
    else io.writeStderr(rendered);
    io.setExitCode(result.exitCode);
  });
  return result.exitCode;
});
