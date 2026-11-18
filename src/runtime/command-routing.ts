/**
 * Which dispatcher owns a command line, decided from the argv tokens alone.
 *
 * These groups run their own dispatchers before `evaluateCli`. The entrypoint
 * imports each group's command graph only after it has chosen that group, so
 * this module must stay free of Effect and of every command module.
 */

export const isSecretsCommand = (arguments_: ReadonlyArray<string>): boolean =>
  arguments_.filter((value) => value !== "--json")[0] === "secrets";

/**
 * `--json` is a global option that `evaluateCli` accepts at any position, so it
 * never names the command. Match past it, or `canonfig --json installer list`
 * would miss this branch and fail as an unknown command.
 */
export const isInstallerCommand = (arguments_: ReadonlyArray<string>): boolean =>
  arguments_.filter((value) => value !== "--json")[0] === "installer";

/** Drop the command head, keeping any global option that came before it. */
export const installerArguments = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> => {
  const head = arguments_.indexOf("installer");
  return arguments_.filter((value, index) => index !== head);
};

/** Drop only the selected dispatcher head, retaining global JSON flags. */
export const secretsArguments = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> => {
  const head = arguments_.indexOf("secrets");
  return arguments_.filter((_, index) => index !== head);
};

/** Help switches and supported positional group-help forms precede version. */
export const groupHelpRequested = (arguments_: ReadonlyArray<string>): boolean => {
  const positional = arguments_.filter((argument) => argument !== "--json");
  return arguments_.includes("--help") || arguments_.includes("-h")
    || ((positional[0] === "secrets" || positional[0] === "skills" || positional[0] === "self-update") && positional[1] === "help");
};

export const isSkillsCommand = (arguments_: ReadonlyArray<string>): boolean =>
  arguments_.filter((value) => value !== "--json")[0] === "skills";

export const skillsArguments = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> => {
  const head = arguments_.indexOf("skills");
  return arguments_.filter((_, index) => index !== head);
};

/** MCP stdout is a protocol stream, so no JSON output option is accepted. */
export const validMcpRunArguments = (args: ReadonlyArray<string>): boolean =>
  args.length === 2 && args[0] === "run" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(args[1]!);

export const isReportIssueCommand = (args: ReadonlyArray<string>): boolean =>
  args.find((argument) => argument !== "--json") === "report-issue";

export type IssueReportingPreferenceCommand =
  | { readonly kind: "status" | "account" | "disable" }
  | { readonly kind: "enable"; readonly accountId: string; readonly revision: string };

type ReportIssueCommand = IssueReportingPreferenceCommand | { readonly kind: "preview" | "submit" | "automatic" };

export function parseReportIssueArguments(args: ReadonlyArray<string>): ReportIssueCommand | undefined {
  const [command, ...options] = args.filter((argument) => argument !== "--json");
  if (command !== "report-issue") return undefined;
  if (options[0] === "automatic") {
    const setting = options[1];
    if (options.length === 2 && (setting === "status" || setting === "account" || setting === "disable")) {
      return { kind: setting };
    }
    const [, , accountFlag, accountId, revisionFlag, revision] = options;
    if (options.length === 6 && setting === "enable" && accountFlag === "--account"
      && accountId && /^[1-9]\d*$/u.test(accountId) && revisionFlag === "--revision" && revision
      && /^(?:absent|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u.test(revision)) {
      return { kind: "enable", accountId, revision };
    }
    return undefined;
  }
  if (!options.includes("--stdin")) return undefined;
  if (options.length === 1) return { kind: "preview" };
  if (options.length === 2 && options.includes("--submit")) return { kind: "submit" };
  if (options.length === 2 && options.includes("--automatic")) return { kind: "automatic" };
  return undefined;
}
