import path from "node:path";
import { CliExitCode } from "../../cli/exit-codes.ts";
import { CanonfigError, errorMessage } from "../core/errors.ts";
import { harnessFailureExitCode, renderHarnessResult, toCliPayload, type HarnessConfigurationCliIo } from "../cli-output.ts";
import { checkSkills, listSkills, trackSkill, updateSkills } from "./manager.ts";

export const skillsHelp = `Canonfig upstream skill updates

Usage: canonfig skills <track|list|check|update> [options]

  track   Record upstream provenance for an existing, matching skill
  list    List configured sources (no network)
  check   Compare upstream and local state without changing installed files
  update  Preview updates; --apply is required to replace installed skills

  --root <path>     Root containing installed skills (default: current directory)
  --config <path>   Root-relative source configuration (default: .canonfig/skills-sources.json)
  --name <id>       Skill name; repeat to select updates (default: all tracked)
  --path <path>     Root-relative installed directory, required for track
  --source <repo>   HTTPS Git URL or local repository path, required for track
  --ref <ref>       Explicit upstream branch, tag or commit, required for track
  --subdir <path>   Skill directory inside upstream repository (default: .)
  --apply           Apply an update after conflict checks; no force overwrite
  --dry-run         Explicit update preview (same as update without --apply)
  --json            Emit canonfig.cli/v1 structured output
  --no-input        Never prompt (all commands are noninteractive)

No skill scripts, Git hooks or install commands are executed. HTTPS sources
must be publicly accessible; credential helpers and interactive login are disabled.
`;
export function parseSkillsArguments(args: readonly string[]) {
  const filtered = args.filter((arg) => arg !== "--json" && arg !== "--no-input");
  const command = filtered[0] ?? "help";
  if (command === "help" || args.includes("--help") || args.includes("-h")) return { command: "help", location: { root: process.cwd(), config: ".canonfig/skills-sources.json" }, values: new Map<string, string>(), names: [] as string[], apply: false };
  if (!["track", "list", "check", "update"].includes(command)) throw new CanonfigError("SKILL_COMMAND_UNKNOWN", `Unknown skills command: ${command}`);
  const values = new Map<string, string>(); const names: string[] = [];
  let apply = false; let dryRun = false;
  for (let index = 1; index < filtered.length; index++) {
    const arg = filtered[index]!;
    if (arg === "--apply") { apply = true; continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (!["--root", "--config", "--name", "--path", "--source", "--ref", "--subdir"].includes(arg)) throw new CanonfigError("SKILL_OPTION_UNKNOWN", `Unknown skills option: ${arg}`);
    const value = filtered[++index];
    if (!value || value.startsWith("--")) throw new CanonfigError("SKILL_OPTION_REQUIRED", `${arg} requires a value`);
    if (arg === "--name") names.push(value);
    else {
      if (values.has(arg)) throw new CanonfigError("SKILL_OPTION_INVALID", `${arg} must not be repeated`);
      values.set(arg, value);
    }
  }
  if ((apply || dryRun) && command !== "update") throw new CanonfigError("SKILL_OPTION_NOT_ALLOWED", "--apply and --dry-run are only valid with update");
  if (apply && dryRun) throw new CanonfigError("SKILL_OPTION_INVALID", "Choose either --apply or --dry-run");
  if (command !== "track" && ["--path", "--source", "--ref", "--subdir"].some((key) => values.has(key))) throw new CanonfigError("SKILL_OPTION_NOT_ALLOWED", "Source registration options are only valid with track; edit the source configuration to change tracked refs");
  const location = { root: path.resolve(values.get("--root") ?? process.cwd()), config: values.get("--config") ?? ".canonfig/skills-sources.json" };
  if (command === "track" && (names.length !== 1 || !values.get("--source") || !values.get("--ref") || !values.get("--path"))) throw new CanonfigError("SKILL_TRACK_REQUIRED", "track requires exactly one --name, --path, --source and --ref");
  if (command === "list" && names.length) throw new CanonfigError("SKILL_OPTION_NOT_ALLOWED", "list does not accept --name");
  return { command, location, values, names, apply };
}

export async function runSkillsCli(args: readonly string[], io: HarnessConfigurationCliIo): Promise<void> {
  const json = args.includes("--json");
  const filtered = args.filter((arg) => arg !== "--json" && arg !== "--no-input");
  const command = filtered[0] ?? "help";
  try {
    if (command === "help" || args.includes("--help") || args.includes("-h")) {
      renderHarnessResult(io, { command: "skills.help", message: "Upstream skill commands", exitCode: CliExitCode.success, json, human: skillsHelp }); return;
    }
    const { location, values, names, apply } = parseSkillsArguments(args);
    if (command === "track") {
      const source = values.get("--source"); const ref = values.get("--ref"); const directory = values.get("--path");
      if (names.length !== 1 || !source || !ref || !directory) throw new CanonfigError("SKILL_TRACK_REQUIRED", "track requires exactly one --name, --path, --source and --ref");
      const skill = await trackSkill(location, { name: names[0]!, path: directory, source, ref, subdir: values.get("--subdir") ?? "." });
      renderHarnessResult(io, { command: "skills.track", message: "Skill provenance recorded", data: toCliPayload(skill), exitCode: CliExitCode.success, json, human: `Tracking ${skill.name} at ${skill.path} (${skill.commit})\n` }); return;
    }
    if (command === "list") {
      if (names.length) throw new CanonfigError("SKILL_OPTION_NOT_ALLOWED", "list does not accept --name; use check for selection");
      const config = await listSkills(location);
      renderHarnessResult(io, { command: "skills.list", message: "Tracked skills listed", data: toCliPayload(config), exitCode: CliExitCode.success, json, human: config.skills.length ? config.skills.map((skill) => `${skill.name}: ${skill.path} [${skill.ref}]`).join("\n") + "\n" : "No skills tracked. Use canonfig skills track to register an existing skill.\n" }); return;
    }
    const checks = command === "update" && apply ? await updateSkills(location, names) : await checkSkills(location, names);
    const conflicts = checks.some((check) => check.status === "local-edits");
    renderHarnessResult(io, { command: `skills.${command}`, message: apply ? "Skill updates applied" : "Skill update preview", data: toCliPayload({ applied: apply, skills: checks }), exitCode: conflicts ? CliExitCode.conflictOrDrift : CliExitCode.success, json,
      human: checks.length ? checks.map((check) => `${check.name}: ${apply && check.status === "update-available" ? "updated" : check.status} (+${check.added.length} ~${check.changed.length} -${check.removed.length})`).join("\n") + (apply ? "\n" : "\nPreview only. Use update --apply to write; local edits will block the entire selected update.\n") : "No skills tracked. Nothing changed.\n" });
  } catch (error) {
    renderHarnessResult(io, { command: `skills.${command}`, message: errorMessage(error), data: error instanceof CanonfigError ? { code: error.code } : undefined, exitCode: harnessFailureExitCode(error), json });
  }
}
