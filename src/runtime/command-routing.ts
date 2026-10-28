/**
 * Which dispatcher owns a command line, decided from the argv tokens alone.
 *
 * These groups run their own dispatchers before `evaluateCli`. The entrypoint
 * imports each group's command graph only after it has chosen that group, so
 * this module must stay free of Effect and of every command module.
 */

export const isSecretsCommand = (arguments_: ReadonlyArray<string>): boolean =>
  arguments_.filter((value) => value !== "--json")[0] === "secrets";

export const isHarnessConfigurationCommand = (arguments_: ReadonlyArray<string>): boolean =>
  arguments_.filter((value) => value !== "--json")[0] === "harness";

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

export const harnessArguments = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> => {
  const head = arguments_.indexOf("harness");
  return arguments_.filter((_, index) => index !== head);
};

/** Help switches and supported positional group-help forms precede version. */
export const groupHelpRequested = (arguments_: ReadonlyArray<string>): boolean => {
  const positional = arguments_.filter((argument) => argument !== "--json");
  return arguments_.includes("--help") || arguments_.includes("-h")
    || ((positional[0] === "secrets" || positional[0] === "harness" || positional[0] === "skills" || positional[0] === "self-update") && positional[1] === "help");
};

export const isSkillsCommand = (arguments_: ReadonlyArray<string>): boolean =>
  arguments_.filter((value) => value !== "--json")[0] === "skills";

export const skillsArguments = (arguments_: ReadonlyArray<string>): ReadonlyArray<string> => {
  const head = arguments_.indexOf("skills");
  return arguments_.filter((_, index) => index !== head);
};

/** Authored-file reconciliation needs no enrollment, credentials or state DB. */
export const isSourceSkillReconciliation = (args: ReadonlyArray<string>): boolean => {
  const positional = args.filter((arg) => arg !== "--json");
  return positional[0] === "source" && positional[1] === "reconcile-skills";
};
export const sourceSkillReconciliationArguments = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const head = args.indexOf("source");
  const command = args.findIndex((value,index) => index > head && value !== "--json");
  return args.filter((_, index) => index !== head && index !== command);
};
