// Quoting for the commands the GUI shows for running on another machine (invitation
// steps). Pasting one into a POSIX shell must pass each value as the single argument
// the GUI meant (`--name "Jane Doe"`, not two words).

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * One shell argument. Plain words stay bare; anything else is single-quoted.
 * A bare `~` or a leading `~/` stays outside the quotes so the shell still expands it.
 */
export function shq(arg: string): string {
  if (arg === "") return "''";
  if (arg === "~" || arg === "~/") return arg;
  if (arg.startsWith("~/")) return `~/${shq(arg.slice(2))}`;
  if (SAFE.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}
