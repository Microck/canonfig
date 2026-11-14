import { Schema } from "effect";
import { adapterFor } from "./adapters/index.ts";
import type { RootContext } from "./harness.ts";
import type { CanonicalModel } from "./model.ts";

export const ShieldPolicy = Schema.Struct({ enabled: Schema.Boolean, hard: Schema.Boolean });
export type ShieldPolicy = typeof ShieldPolicy.Type;
export const shieldHookId = "canonfig-shield";

/** Only configuration surfaces and skill readers, never whole homes or credentials. */
export const shieldPaths = (model: CanonicalModel, context: RootContext) => {
  const paths = model.harnesses.flatMap((harness) => {
    const layout = adapterFor(harness).layout(context, model);
    return [
      ...layout.surfaces.flatMap((surface) => [surface.target, ...(surface.kind === "config" ? surface.alternatives ?? [] : [])]),
      ...layout.skillSources.map((source) => source.path),
      context.join(layout.root, ".canonfig-plugins"),
      ...(["claude-code", "codex"].includes(harness) ? [context.join(layout.root, "plugins", "cache")] : []),
      ...layout.surfaces.filter((surface) => surface.id === "plugin" || surface.id === "extension").map((surface) => context.join(surface.target, "..")),
      ...(harness === "qwen" ? [context.join(layout.root, "extensions")] : []),
    ];
  });
  return [...new Set([...paths, context.join(context.home, ".agents", "skills")])];
};

/** Generated, dependency-free guard. Shell inspection is advisory, not a shell parser or sandbox. */
const guardSource = (paths: ReadonlyArray<string>, home: string, destination: string, logFile: string) => `
import fs from "node:fs";
import path from "node:path";
const protectedPaths = ${JSON.stringify(paths)};
const home = ${JSON.stringify(home)};
const destination = ${JSON.stringify(destination)};
const logFile = ${JSON.stringify(logFile)};
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const raw = input.raw ?? {};
const tool = input.toolName;
let args = input.toolInput;
const textInput = typeof args === "string" ? args : "";
if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = { command: args }; } }
const cwd = args?.cwd ?? args?.workdir ?? args?.working_directory ?? args?.Cwd ?? raw.cwd ?? input.cwd;
const expand = (value) => value.replace(/^~(?=[/\\\\]|$)/, home).replace(/\\$\\{?HOME\\}?|%USERPROFILE%/g, home);
const resolve = (value) => path.resolve(cwd, expand(value));
const physical = (value) => {
  try { return fs.realpathSync(value); }
  catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    const parent = path.dirname(value);
    return parent === value ? value : path.join(physical(parent), path.basename(value));
  }
};
const within = (value, root) => { if (process.platform !== "linux") { value = value.toLowerCase(); root = root.toLowerCase(); } return value === root || value.startsWith(root + path.sep); };
let blockedRelative = "";
let blockedPath = "";
let blockedInstaller = "";
const match = (value) => {
  const absolute = resolve(value);
  const actual = physical(absolute);
  const root = protectedPaths.find((root) => within(absolute, root) || within(actual, physical(root)));
  if (root) {
    blockedRelative = within(actual, physical(root)) ? path.relative(physical(root), actual) : path.relative(root, absolute);
    blockedPath = absolute;
  }
  return root;
};
const writeTool = /(write|edit|patch|create|delete|move|replace)/i.test(tool);
const shellTool = /(bash|shell|terminal|execute|exec|command)/i.test(tool);
let blocked;
if (writeTool) {
  const visit = (value, key = "") => {
    if (typeof value === "string" && /^(file_?path|path|target_?file|target|destination|old_path|new_path)$/i.test(key)) blocked ??= match(value);
    else if (value && typeof value === "object") for (const [name, child] of Object.entries(value)) visit(child, name);
  };
  visit(args);
  // Codex sends patch text in command; OMP uses hashline headers in input.
  const patch = args?.patch ?? args?.input ?? args?.command ?? textInput;
  for (const entry of String(patch).matchAll(/^\\*\\*\\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)) blocked ??= match(entry[1]);
  for (const entry of String(patch).matchAll(/^\\[([^\\n]+)#[a-fA-F0-9]{4}\\]$/gm)) blocked ??= match(entry[1]);
  for (const entry of String(patch).matchAll(/^MV (?:"([^"]+)"|(.+))$/gm)) blocked ??= match(entry[1] ?? entry[2]);
}
if (shellTool) {
  const command = expand(String(args?.command ?? args?.CommandLine ?? args?.cmd ?? raw.command ?? ""));
  // Canonfig's installer and sync commands are the explicit write boundary.
  const canonfig = /^\\s*canonfig\\s+(?:shield\\s+(?:install|ingest|review|add-plugin)|sync\\s+--apply)(?:\\s|$)/.test(command) && !/[;|&\\n<>\`]|\\$\\(/.test(command);
  if (!canonfig) {
    // Paths alone are not writes: agents must still be able to read projected instructions.
    const mutates = /(?:\\b(?:mkdir|touch|cp|mv|rm|install|tee|dd|ln|chmod|chown|truncate|Set-Content|Add-Content|Remove-Item|New-Item)\\b|\\bsed\\s+[^;]*-i|\\b(?:node|python[0-9.]*|perl|ruby)\\s+[^;]*-[ec]|\\b(?:writeFile|write_text|write_bytes|appendFile)\\s*\\()/i.test(command);
    if (mutates) for (const token of command.split(/[\\s'";|&<>]+/)) if (token && (token.includes("/") || token.includes("\\\\"))) blocked ??= match(token);
    for (const redirect of command.matchAll(/>{1,2}\\s*(?:"([^"]+)"|'([^']+)'|([^\\s;&|<>]+))/g)) blocked ??= match(redirect[1] ?? redirect[2] ?? redirect[3]);
    const installer = command.match(/(?:\\bskills\\s+(?:add|install)|\\b(?:claude|codex|gemini|qwen)\\s+(?:mcp\\s+add|plugins?\\s+(?:install|add)|extensions\\s+(?:install|link)))/);
    if (installer) { blocked ??= "installer"; blockedInstaller ||= installer[0].replace(/\\s+/g, " "); }
  }
}
if (blocked) {
  // The log is history for the Shield page (see shield-log.ts). It holds the refused path or installer phrase,
  // never content or arguments. A failed append must not turn a block into a crash, so its error is dropped.
  const entry = { at: new Date().toISOString(), kind: "blocked", harness: input.target };
  if (blockedPath) entry.path = within(blockedPath, home) ? "~" + blockedPath.slice(home.length) : blockedPath;
  else if (blockedInstaller) entry.installer = blockedInstaller;
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 }); fs.appendFileSync(logFile, JSON.stringify(entry) + "\\n", { mode: 0o600 }); } catch {}
  const category = protectedPaths.includes(blocked) && /[/\\\\]skills$/.test(blocked) ? "skills/" + blockedRelative : "";
  console.log(JSON.stringify({ decision: "deny", reason: "Canonfig Shield blocked a harness installation. Write authored content to " + path.join(destination, category) + "; for installers run canonfig shield install -- <original command>. Run canonfig sync --apply afterward. Native plugins need canonfig shield review before activation. Never publish automatically." }));
  process.exit(2);
}
`;

export const shieldModel = (model: CanonicalModel, context: RootContext, scope: "canonical" | "local"): CanonicalModel => {
  if (model.hooks.some((hook) => hook.id === shieldHookId) || model.skills.some((skill) => skill.name === shieldHookId)) {
    throw new Error(`${shieldHookId} is reserved while Shield is enabled`);
  }
  const destination = scope === "local" ? context.join(model.folder, "local") : model.folder;
  const instructions = `## Canonfig Shield\n\nInstall skills, MCP servers and native plugins through \`canonfig shield install -- <original command>\`. Never install into harness configuration folders or ~/.agents. Author skills under ${destination}/skills/, documents in the matching category, and MCP entries in ${destination}/${scope === "local" ? "local.jsonc" : "canonfig.jsonc"}. Respect local.allow and Local Overlays. Run \`canonfig sync --apply\` after changes. Review native plugin bytes with \`canonfig shield review <id> --digest <sha256> --reviewer <name>\` before activation. Redirected changes are not permission to publish.\n`;
  return {
    ...model,
    instructions: `${model.instructions === undefined ? "" : model.instructions + "\n"}${instructions}`,
    skills: [...model.skills, { name: shieldHookId, description: "Install agent configuration through Canonfig without contaminating harness folders.",
      files: [{ path: "SKILL.md", executable: false, content: new TextEncoder().encode(`---\nname: ${shieldHookId}\ndescription: Install skills, MCP servers and native plugins through Canonfig.\n---\n\n${instructions}`) }] }],
    hooks: [{ id: shieldHookId, event: "before_tool", matcher: { capabilities: [], tools: [] },
      run: ["node", "--input-type=module", "-e", guardSource(shieldPaths(model, context), context.home, destination, context.join(model.folder, ".shield", "log.jsonl"))], timeoutMs: 5000, onFailure: "block" }, ...model.hooks],
  };
};
