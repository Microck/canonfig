import { lstat, readFile, rename, unlink, mkdir, rmdir, realpath, open } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Predicate, Schema } from "effect";
import { asJson, canonicalJson, sha256Hex } from "./profile-codec.ts";

const portable = ["description", "why", "when", "install_url", "install_manager", "install_sha256"] as const;
type Tool = Record<string, string | boolean>;
export interface Catalogue { version: 1; tools: Record<string, Tool>; projects?: string[] }
interface State { version: 1; config: string; bundle: string; owned: Record<string, Tool> }
function fail(message: string): never { throw new Error(message); }
const PortableTool = Schema.Struct({
  description: Schema.optional(Schema.String), why: Schema.optional(Schema.String), when: Schema.optional(Schema.String),
  install_url: Schema.optional(Schema.String), install_manager: Schema.optional(Schema.String), install_sha256: Schema.optional(Schema.String),
});
const LocalTool = Schema.Struct({ ...PortableTool.fields, path: Schema.optional(Schema.String), help: Schema.optional(Schema.String), hide: Schema.optional(Schema.Boolean), include: Schema.optional(Schema.Boolean) });
const PortableCatalogue = Schema.Struct({ version: Schema.optional(Schema.Literal(1)), tools: Schema.Record(Schema.String, PortableTool) });
const LocalCatalogue = Schema.Struct({ version: Schema.optional(Schema.Literal(1)), tools: Schema.Record(Schema.String, LocalTool), projects: Schema.optional(Schema.Array(Schema.String)) });
const OwnershipState = Schema.Struct({ version: Schema.Literal(1), config: Schema.String, bundle: Schema.String, owned: Schema.Record(Schema.String, PortableTool) });
const text = (value: string): boolean => !/[\p{Cc}\u2028\u2029]/u.test(value);
const equal = (a: Tool, b: Tool) => canonicalJson(asJson(a)) === canonicalJson(asJson(b));
const encode = <Value>(value: Value) => `${JSON.stringify(value, null, 2)}\n`;
const project = (tool: Tool): Tool => Object.fromEntries(portable.filter((key) => Predicate.isString(tool[key]) && tool[key] !== "").map((key) => [key, tool[key]]));

/** Version-1 portable metadata only. Never an installer, shell, or approval import. */
export function decodeCatalogue(bytes: string, bundle = false): Catalogue {
  if (Buffer.byteLength(bytes) > 1_048_576) fail("Catalogue exceeds 1 MiB");
  const parsed = JSON.parse(bytes);
  if (bundle) Schema.decodeUnknownSync(PortableCatalogue, { onExcessProperty: "error" })(parsed);
  const value = Schema.decodeUnknownSync(LocalCatalogue, { onExcessProperty: "error" })(parsed);
  const tools: Record<string, Tool> = Object.create(null);
  const names = new Set<string>();
  for (const [name, input] of Object.entries(value.tools)) {
    if (!text(name) || !name.trim() || name === "." || name === ".." || /[/\\]/u.test(name) || ["__proto__", "constructor", "prototype"].includes(name)) fail(`Invalid tool name: ${name}`);
    if (names.has(name.toLowerCase())) fail(`Case-colliding tool name: ${name}`);
    names.add(name.toLowerCase());
    const tool: Tool = {};
    for (const [key, field] of Object.entries(input)) {
      if (field === undefined) continue;
      if (Predicate.isString(field)) {
        if (!text(field)) fail(`Invalid text: ${name}.${key}`);
        if (["description", "why", "when"].includes(key) && [...field].length > 240) fail(`Text too long: ${name}.${key}`);
        if (key === "help" && [...field].length > 500) fail("Help too long");
        if (key === "path" && field && (field.length > 4096 || !/^(?:\/|[A-Za-z]:[/\\]|\\\\[^\\]+\\[^\\]+)/u.test(field))) fail(`Invalid executable path: ${name}`);
      }
      const normalized = Predicate.isString(field) && ["description", "why", "when", "help"].includes(key) ? field.trim() : field;
      if (portable.some((entry) => entry === key) && normalized === "") continue;
      tool[key] = normalized;
    }
    if (tool.hide && tool.include) fail(`Conflicting visibility: ${name}`);
    if (bundle && !(Predicate.isString(tool.description) && tool.description.trim())) fail(`Portable tool needs a description: ${name}`);
    validateInstall(tool, name);
    tools[name] = tool;
  }
  const result: Catalogue = { version: 1, tools };
  if (value.projects) {
    if (value.projects.some((entry) => !text(entry) || !/^(?:\/|[A-Za-z]:[/\\]|\\\\)/u.test(entry))) fail("Invalid project path");
    result.projects = [...value.projects];
  }
  return result;
}

/** Mirrors lsops 0.5's supported source identities; never fetches a URL. */
function validateInstall(tool: Tool, name: string): void {
  const link = String(tool.install_url ?? ""); const manager = String(tool.install_manager ?? ""); const digest = String(tool.install_sha256 ?? "");
  if (!link) { if (manager || digest) fail(`Install metadata needs a URL: ${name}`); return; }
  const url = new URL(link);
  if (Buffer.byteLength(link) > 2048 || !link.startsWith("https://") || url.protocol !== "https:" || url.username || url.password || link.includes("?") || link.includes("#") || /[\\\s]/u.test(link)) fail(`Install URL must be plain credential-free HTTPS: ${name}`);
  if (["sh", "bash", "pwsh", "powershell"].includes(manager)) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) fail(`Script needs reviewed lowercase SHA256: ${name}`);
    return;
  }
  if (digest) fail(`Only scripts may carry a digest: ${name}`);
  if (link.includes("%")) fail(`Encoded package URL is unsupported: ${name}`);
  const rawPath = link.slice("https://".length + url.host.length);
  if (link.slice(8).split("/")[0] !== url.host || rawPath !== url.pathname) fail(`Noncanonical package URL: ${name}`);
  const p = url.pathname.replace(/\/$/u, ""); let inferred = "";
  const simple = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u; const brew = /^[a-z0-9][a-z0-9+@._-]*$/u;
  if (["npmjs.com", "www.npmjs.com"].includes(url.host) && p.startsWith("/package/") && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(p.slice(9))) inferred = "npm";
  if (url.host === "pypi.org" && p.startsWith("/project/") && simple.test(p.slice(9))) inferred = "uv";
  if (url.host === "crates.io" && p.startsWith("/crates/") && simple.test(p.slice(8))) inferred = "cargo";
  if (url.host === "formulae.brew.sh") {
    if (p.startsWith("/formula/") && brew.test(p.slice(9))) inferred = "brew";
    if (p.startsWith("/cask/") && brew.test(p.slice(6))) inferred = "brew-cask";
  }
  if (url.host === "pkg.go.dev") {
    const pkg = p.slice(1);
    if (/^[A-Za-z0-9][A-Za-z0-9._~/-]*$/u.test(pkg) && pkg.split("/")[0].includes(".") && !pkg.includes("//") && !pkg.split("/").some((part) => part === "." || part === "..")) inferred = "go";
  }
  if (["github.com", "raw.githubusercontent.com"].includes(url.host)) {
    const parts = p.slice(1).split("/");
    if (url.host === "github.com" && parts.length === 6 && parts[2] === "blob") parts.splice(2, 1);
    const segment = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
    if (parts.length === 5 && segment.test(parts[0]) && parts[1].startsWith("homebrew-") && segment.test(parts[1].slice(9)) && segment.test(parts[2]) && parts[4].endsWith(".rb") && brew.test(parts[4].slice(0, -3))) {
      if (parts[3] === "Formula") inferred = "brew";
      if (parts[3] === "Casks") inferred = "brew-cask";
    }
  }
  if (!inferred || manager && manager !== inferred && !(inferred === "npm" && ["bun", "pnpm"].includes(manager)) && !(inferred === "uv" && manager === "pipx")) fail(`Unsupported or mismatched lsops install source: ${name}`);
}

/** Includes only visible curated descriptions, not paths, trust, help or approvals. */
export function exportCatalogue(config: Catalogue): Catalogue {
  return { version: 1, tools: Object.fromEntries(Object.entries(config.tools).filter(([, tool]) => !tool.hide && tool.description).map(([name, tool]) => [name, project(tool)])) };
}

export function planCatalogue(config: Catalogue, incoming: Catalogue, owned: Record<string, Tool>) {
  const next: Catalogue = structuredClone(config);
  const nextOwned: Record<string, Tool> = Object.create(null);
  const added: string[] = []; const updated: string[] = []; const removed: string[] = []; const localNames: string[] = []; const conflicts: string[] = [];
  const actualNames = new Map(Object.keys(config.tools).map((name) => [name.toLowerCase(), name]));
  for (const name of new Set([...Object.keys(owned), ...Object.keys(incoming.tools)])) {
    const actual = actualNames.get(name.toLowerCase());
    if (actual && actual !== name) { conflicts.push(`${name}: case differs from local ${actual}`); continue; }
    const current = Object.hasOwn(config.tools, name) ? config.tools[name] : undefined;
    const previous = Object.hasOwn(owned, name) ? owned[name] : undefined;
    const desired = Object.hasOwn(incoming.tools, name) ? incoming.tools[name] : undefined;
    if (!previous) {
      if (current) {
        if (desired && !equal(project(current), desired)) conflicts.push(`${name}: independently registered locally`);
        else localNames.push(name); // Identical pre-existing entries stay local, never adopted.
      } else if (desired) { next.tools[name] = desired; nextOwned[name] = desired; added.push(name); }
      continue;
    }
    if (!current || !equal(project(current), previous)) { conflicts.push(`${name}: local edits to shared metadata`); continue; }
    if (desired) {
      next.tools[name] = { ...Object.fromEntries(Object.entries(current).filter(([key]) => !portable.some((field) => field === key))), ...desired };
      nextOwned[name] = desired;
      if (!equal(previous, desired)) updated.push(name);
    } else {
      const remaining = Object.fromEntries(Object.entries(current).filter(([key]) => !portable.some((field) => field === key)));
      if (Object.keys(remaining).length) next.tools[name] = remaining; else delete next.tools[name];
      removed.push(name);
    }
  }
  return { next, owned: nextOwned, added, updated, removed, local: localNames, conflicts };
}

async function safePath(file: string): Promise<void> {
  const parent = path.dirname(file);
  // Refuse symlink ancestors, not only the final entry. The parent must exist.
  if (path.resolve(await realpath(parent)) !== path.resolve(parent)) fail(`Symlink ancestor: ${file}`);
  try { if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) fail(`Not a regular file: ${file}`); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
}
async function read(file: string): Promise<string | undefined> {
  await safePath(file);
  try { if ((await lstat(file)).size > 1_048_576) fail(`File exceeds 1 MiB: ${file}`); const bytes = await readFile(file); if (bytes.length > 1_048_576) fail(`File exceeds 1 MiB: ${file}`); return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
async function replace(file: string, bytes: string, expected: string | undefined): Promise<void> {
  await safePath(file);
  if (await read(file) !== expected) fail(`Concurrent edit: ${file}`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const mode = expected === undefined ? 0o600 : (await lstat(file)).mode & 0o777;
  try {
    const handle = await open(temporary, "wx", mode);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    if (await read(file) !== expected) fail(`Concurrent edit: ${file}`);
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function statIfPresent(file: string) {
  try { return await lstat(file, { bigint: true }); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
/** Reserve case variants on every OS; also reject hard-link and filesystem aliases. */
async function assertSeparateDestination(config: string, bundle: string): Promise<void> {
  const state = `${config}.canonfig-lsops.json`;
  const destination = await statIfPresent(bundle);
  for (const file of [config, state, `${state}.pending`, `${state}.lock`]) {
    if (file.toLowerCase() === bundle.toLowerCase()) fail("Bundle must be separate from local config and state (different files)");
    const reserved = await statIfPresent(file);
    if (destination && reserved && destination.dev === reserved.dev && destination.ino === reserved.ino) fail("Bundle must be separate from local config and state: filesystem alias");
  }
}

export interface BridgeOptions { config: string; bundle: string; apply: boolean }
export interface BridgeOperations { readonly replace: typeof replace; readonly syncDirectory?: typeof syncDirectory }
const operations: BridgeOperations = { replace };
export async function captureCatalogue(options: BridgeOptions) {
  const config = path.resolve(options.config); const bundle = path.resolve(options.bundle);
  await assertSeparateDestination(config, bundle);
  const raw = await read(config); if (raw === undefined) fail("Source lsops config does not exist");
  const catalogue = exportCatalogue(decodeCatalogue(raw));
  decodeCatalogue(encode(catalogue), true);
  const previous = await read(bundle);
  if (options.apply && previous !== encode(catalogue)) await replace(bundle, encode(catalogue), previous);
  return { tools: Object.keys(catalogue.tools), changed: previous !== encode(catalogue), catalogue };
}

/** Independent bridge lock; stop other lsops writers during apply. Never touch .updates.json. */
export async function synchronizeCatalogue(options: BridgeOptions, run: BridgeOperations = operations) {
  const config = path.resolve(options.config); const bundle = path.resolve(options.bundle);
  const statePath = `${config}.canonfig-lsops.json`; const journalPath = `${statePath}.pending`;
  await assertSeparateDestination(config, bundle);
  await safePath(config);
  const lock = `${statePath}.lock`;
  if (options.apply) await mkdir(lock).catch((error) => { if (error instanceof Error && "code" in error && error.code === "EEXIST") fail(`Bridge locked: ${lock}. Check the previous process before removing a stale lock.`); throw error; });
  try {
    const pending = await read(journalPath);
    if (pending !== undefined) fail(`Interrupted update: inspect ${journalPath} and restore its config backup before removing the pending journal. No automatic overwrite.`);
    const input = await read(bundle); if (input === undefined) fail("Shared catalogue is missing; absence is not an empty catalogue");
    const incoming = decodeCatalogue(input, true);
    const before = await read(config); const current = decodeCatalogue(before ?? '{"version":1,"tools":{}}');
    const rawState = await read(statePath);
    let owned: Record<string, Tool> = {};
    if (rawState !== undefined) {
      const state = Schema.decodeUnknownSync(OwnershipState, { onExcessProperty: "error" })(JSON.parse(rawState));
      if (state.version !== 1 || state.config !== config || state.bundle !== bundle) fail("Ownership state does not match this config and shared catalogue");
      owned = decodeCatalogue(encode({ version: 1, tools: state.owned }), true).tools;
    }
    const plan = planCatalogue(current, incoming, owned);
    if (!options.apply || plan.conflicts.length > 0) return plan;
    const state: State = { version: 1, config, bundle, owned: plan.owned };
    const after = encode(plan.next); const stateAfter = encode(state);
    if (Buffer.byteLength(after) > 1_048_576 || Buffer.byteLength(stateAfter) > 1_048_576) fail("Merged catalogue or ownership state exceeds 1 MiB");
    if (before === after && rawState === stateAfter) return plan;
    if (await read(bundle) !== input || await read(config) !== before || await read(statePath) !== rawState) fail("Concurrent edit before apply");
    // Recovery evidence comes first. A partial write never silently loses ownership.
    const journal = await open(journalPath, "wx", 0o600);
    try {
      await journal.writeFile(encode({ version: 1, config, bundle, before: before ?? null, stateBefore: rawState ?? null, afterDigest: sha256Hex(after), stateAfter: state }));
      await journal.sync();
    } finally { await journal.close(); }
    await (run.syncDirectory ?? syncDirectory)(path.dirname(journalPath));
    await run.replace(config, after, before);
    await run.replace(statePath, stateAfter, rawState);
    await unlink(journalPath);
    await (run.syncDirectory ?? syncDirectory)(path.dirname(journalPath));
    return plan;
  } finally { if (options.apply) await rmdir(lock); }
}
