import path from "node:path";
import { automaticSkillUpdates, type AutomaticSkillOptions } from "./automatic.ts";
import { CliExitCode } from "../../cli/exit-codes.ts";
import { CanonfigError, errorMessage } from "../core/errors.ts";
import { harnessFailureExitCode, renderHarnessResult, toCliPayload, type HarnessConfigurationCliIo } from "../cli-output.ts";
import { checkSkills, listSkills, trackSkill, updateSkills } from "./manager.ts";

export const skillsHelp = `Canonfig upstream skill updates

Usage: canonfig skills <track|list|check|update|auto> [options]

  track   Record upstream provenance for an existing, matching skill
  list    List configured sources (no network)
  check   Compare upstream and local state without changing installed files
  update  Preview updates; --apply is required to replace installed skills
  auto    Preview once; --apply runs periodic updates, --once supports schedulers

  --root <path>     Root containing installed skills (default: current directory)
  --config <path>   Root-relative source configuration (default: .canonfig/skills-sources.json)
  --name <id>       Skill name; repeat to select updates (default: all tracked)
  --path <path>     Root-relative installed directory, required for track
  --source <repo>   HTTPS Git URL or local repository path, required for track
  --ref <ref>       Explicit upstream branch, tag or commit, required for track
  --subdir <path>   Skill directory inside upstream repository (default: .)
  --apply           Apply an update after conflict checks; no force overwrite
  --interval <sec>  auto cadence after each pass (default 86400; 60..604800)
  --once            auto: one pass instead of a continuous foreground worker
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
  if (!["track", "list", "check", "update", "auto"].includes(command)) throw new CanonfigError("SKILL_COMMAND_UNKNOWN", `Unknown skills command: ${command}`);
  const values = new Map<string, string>(); const names: string[] = [];
  let apply = false; let dryRun = false; let once = false;
  for (let index = 1; index < filtered.length; index++) {
    const arg = filtered[index]!;
    if (arg === "--once") { once = true; continue; }
    if (arg === "--apply") { apply = true; continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (!["--root", "--config", "--name", "--path", "--source", "--ref", "--subdir", "--interval"].includes(arg)) throw new CanonfigError("SKILL_OPTION_UNKNOWN", `Unknown skills option: ${arg}`);
    const value = filtered[++index];
    if (!value || value.startsWith("--")) throw new CanonfigError("SKILL_OPTION_REQUIRED", `${arg} requires a value`);
    if (arg === "--name") names.push(value);
    else {
      if (values.has(arg)) throw new CanonfigError("SKILL_OPTION_INVALID", `${arg} must not be repeated`);
      values.set(arg, value);
    }
  }
  if ((apply || dryRun) && !(["update", "auto"].includes(command))) throw new CanonfigError("SKILL_OPTION_NOT_ALLOWED", "--apply and --dry-run are only valid with update or auto");
  if (apply && dryRun) throw new CanonfigError("SKILL_OPTION_INVALID", "Choose either --apply or --dry-run");
  if (command !== "track" && ["--path", "--source", "--ref", "--subdir"].some((key) => values.has(key))) throw new CanonfigError("SKILL_OPTION_NOT_ALLOWED", "Source registration options are only valid with track; edit the source configuration to change tracked refs");
  const location = { root: path.resolve(values.get("--root") ?? process.cwd()), config: values.get("--config") ?? ".canonfig/skills-sources.json" };
  if (command === "track" && (names.length !== 1 || !values.get("--source") || !values.get("--ref") || !values.get("--path"))) throw new CanonfigError("SKILL_TRACK_REQUIRED", "track requires exactly one --name, --path, --source and --ref");
  if (command === "list" && names.length) throw new CanonfigError("SKILL_OPTION_NOT_ALLOWED", "list does not accept --name");
  if ((once || values.has("--interval")) && command !== "auto") throw new CanonfigError("SKILL_OPTION_NOT_ALLOWED", "--once and --interval require auto");
  const interval = values.get("--interval") ?? "86400";
  if (!/^\d+$/u.test(interval) || !Number.isSafeInteger(Number(interval)) || Number(interval) < 60 || Number(interval) > 604800) throw new CanonfigError("SKILL_OPTION_INVALID", "--interval must be whole seconds between 60 and 604800");
  return { command, location, values, names, apply, once, intervalSeconds: Number(interval) };
}

export async function runSkillsCli(args: readonly string[], io: HarnessConfigurationCliIo, signal?: AbortSignal): Promise<void> {
  const json = args.includes("--json");
  const filtered = args.filter((arg) => arg !== "--json" && arg !== "--no-input");
  const command = filtered[0] ?? "help";
  try {
    if (command === "help" || args.includes("--help") || args.includes("-h")) {
      renderHarnessResult(io, { command: "skills.help", message: "Upstream skill commands", exitCode: CliExitCode.success, json, human: skillsHelp }); return;
    }
    const { location, values, names, apply, once, intervalSeconds } = parseSkillsArguments(args);
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
    if (command === "auto") {
      const automaticOptions: AutomaticSkillOptions = {
        apply, once: once ?? false, intervalSeconds: intervalSeconds ?? 86400, signal,
        onPass: (skills, pass) => renderHarnessResult(io, {
          command: "skills.auto", message: apply ? "Automatic skill update pass completed" : "Automatic skill update preview",
          data: toCliPayload({ applied: apply, pass, skills }),
          exitCode: skills.some((skill) => skill.status === "local-edits") ? CliExitCode.conflictOrDrift : CliExitCode.success,
          json, human: `Pass ${pass}: ${skills.map((skill) => `${skill.name}: ${apply && skill.status === "update-available" ? "updated" : skill.status}`).join(", ")}\n${apply ? "No profile was published or harness configuration applied.\n" : "Preview only; use auto --apply for periodic updates or add --once for an external scheduler.\n"}`,
        }),
      };
      const passes = await automaticSkillUpdates(location, names, automaticOptions);
      if (passes === 0) renderHarnessResult(io, { command: "skills.auto", message: "No automatic update pass ran", exitCode: CliExitCode.success, json });
      return;
    }
    const checks = command === "update" && apply ? await updateSkills(location, names) : await checkSkills(location, names);
    const conflicts = checks.some((check) => check.status === "local-edits");
    renderHarnessResult(io, { command: `skills.${command}`, message: apply ? "Skill updates applied" : "Skill update preview", data: toCliPayload({ applied: apply, skills: checks }), exitCode: conflicts ? CliExitCode.conflictOrDrift : CliExitCode.success, json,
      human: checks.length ? checks.map((check) => `${check.name}: ${apply && check.status === "update-available" ? "updated" : check.status} (+${check.added.length} ~${check.changed.length} -${check.removed.length})`).join("\n") + (apply ? "\n" : "\nPreview only. Use update --apply to write; local edits will block the entire selected update.\n") : "No skills tracked. Nothing changed.\n" });
  } catch (error) {
    const code = error instanceof CanonfigError ? error.code : undefined;
    const exitCode = code === "SKILL_FETCH_FAILED" ? CliExitCode.transport
      : code === "SKILL_RECOVERY_REQUIRED" ? CliExitCode.humanActionRequired
      : code === "SKILL_VERIFY_FAILED" ? CliExitCode.verificationOrApplyFailure
      : harnessFailureExitCode(error);
    renderHarnessResult(io, { command: `skills.${command}`, message: errorMessage(error), data: error instanceof CanonfigError ? { code: error.code } : undefined, exitCode, json });
  }
}
