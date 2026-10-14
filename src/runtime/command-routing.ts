/**
 * Which dispatcher owns a command line, decided from the argv tokens alone.
 *
 * These groups run their own dispatchers before `evaluateCli`. The entrypoint
 * imports each group's command graph only after it has chosen that group, so
 * this module must stay free of Effect and of every command module.
 */

export const isSecretsCommand = (arguments_: ReadonlyArray<string>): boolean =>
  arguments_[0] === "secrets";

export const isHarnessConfigurationCommand = (arguments_: ReadonlyArray<string>): boolean =>
  arguments_[0] === "harness";

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
