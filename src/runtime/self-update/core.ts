import { Schema } from "effect";
import { readSettings } from "./settings.ts";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { acquireGate, assertPrivateDirectory, readersActive, regular, updateDirectory } from "./coordination.ts";

export const parseVersion = (value: string): readonly [number, number, number] => {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) throw new Error(`Unsupported stable version: ${value}`);
  const parts = value.split(".").map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n))) throw new Error("Version component exceeds safe range");
  return [parts[0]!, parts[1]!, parts[2]!];
};
export function latestPatch(current: string, versions: readonly string[]): string {
  const [major, minor, patch] = parseVersion(current);
  let best = patch;
  for (const candidate of versions) {
    if (!/^\d+\.\d+\.\d+$/u.test(candidate)) continue;
    const [a,b,c] = parseVersion(candidate);
    if (a === major && b === minor && c > best) best = c;
  }
  return `${major}.${minor}.${best}`;
}
export interface Invocation { executable: string; args: readonly string[]; timeout?: number }
export type Runner = (invocation: Invocation, signal?: AbortSignal) => Promise<string>;
export const run: Runner = (input, signal) => new Promise((resolveResult,reject) => {
  if (signal?.aborted) { reject(new Error("Self-update cancelled")); return; }
  const env = { ...process.env };
  for(const key of Object.keys(env))if(/^npm_config_/iu.test(key)||["NPM_TOKEN","NODE_AUTH_TOKEN","NODE_OPTIONS"].includes(key.toUpperCase()))delete env[key];
  const child = spawn(input.executable, [...input.args], { env, shell: false, windowsHide: true, stdio: ["ignore","pipe","pipe"] });
  let stdout = ""; let stderr = ""; let failure: Error | undefined; let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: string) => { failure ??= new Error(reason); child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000); };
  const timer = setTimeout(() => stop("Self-update subprocess timed out"), input.timeout ?? 120_000);
  const abort = () => stop("Self-update cancelled"); signal?.addEventListener("abort",abort,{once:true});
  child.stdout.on("data", (data: Buffer) => { if (Buffer.byteLength(stdout)<=2_097_152) stdout += data.toString(); if (Buffer.byteLength(stdout)>2_097_152) stop("Subprocess output exceeds 2 MiB"); });
  child.stderr.on("data", (data: Buffer) => { if (Buffer.byteLength(stderr)<=2_097_152) stderr += data.toString(); if (Buffer.byteLength(stderr)>2_097_152) stop("Subprocess diagnostics exceed 2 MiB"); });
  child.on("error", (e) => { failure = e; });
  child.on("close", (code) => { clearTimeout(timer); if(killTimer)clearTimeout(killTimer); signal?.removeEventListener("abort",abort); if (failure) reject(failure); else if (code !== 0) reject(new Error(`Self-update subprocess failed (${code}); inspect the private updater cache/logs. No activation was confirmed.`)); else resolveResult(stdout); });
  if (signal?.aborted) abort();
});
function within(child: string, parent: string): boolean { const r=relative(parent,child);return r!==""&&!r.startsWith(`..${sep}`)&&r!==".."&&!isAbsolute(r); }
export function installation(root: string, home=homedir()) {
  root=realpathSync(root); home=realpathSync(home);
  const manifest=Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({name:Schema.Literal("@microck/canonfig"),version:Schema.String,bin:Schema.Struct({canonfig:Schema.Literal("dist/runtime/main.js")})})))(readFileSync(join(root,"package.json"),"utf8"));
  
  parseVersion(manifest.version);
  let prefix=dirname(dirname(dirname(root)));
  if(process.platform!=="win32") {if(!prefix.endsWith(`${sep}lib`)) throw new Error("Self-update requires a user-local global npm installation");prefix=dirname(prefix);}
  if(existsSync(join(prefix,"package.json"))||existsSync(join(root,"src"))||existsSync(join(root,".git")))throw new Error("Project/checkouts are not supported self-update targets");
  const expected=join(prefix,...(process.platform==="win32"?[]:["lib"]),"node_modules","@microck","canonfig");
  if(root!==expected||!within(prefix,home))throw new Error("Self-update only supports a user-private global npm prefix under your home; system, project and linked installs require manual updates");
  // Protect every parent that could replace the package or its sibling state,
  // not only the prefix and leaf package. Check through the user home boundary.
  for(let parent=root;;parent=dirname(parent)) {
    assertPrivateDirectory(parent);
    if(parent===home)break;
  }
  return {root,prefix,version:manifest.version};
}
export function assertNoUnfinishedRun(state: string): void {
  if(!existsSync(state))return;
  regular(state);
  const db=new DatabaseSync(state,{readOnly:true});
  try {
    // The updater runs before repository migration. Read the released schema
    // boundary explicitly so 6.1 unfinished runs still block an upgrade.
    const hasPhase=db.prepare("PRAGMA table_info(synchronization_runs)").all().some(column=>column.name==="phase");
    const row=db.prepare(hasPhase
      ? "SELECT id FROM synchronization_runs WHERE phase != 'Complete' LIMIT 1"
      : "SELECT id FROM synchronization_runs WHERE status IN ('applying', 'Interrupted') LIMIT 1").get();
    if(row)throw new Error("An unfinished sync exists. Finish or recover it with the current build before updating.");
  } finally {db.close();}
}
function syncFile(path: string): void {const fd=openSync(path,"r+");try{fsyncSync(fd);}finally{closeSync(fd);}}
export function syncDirectory(path:string):void {if(process.platform!=="win32"){const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}}
export async function enable(root: string,npmCli: string,confirmIdle: boolean,runner:Runner=run, home=homedir(), signal?:AbortSignal):Promise<void>{
  if(signal?.aborted)throw new Error("Self-update cancelled");
  if(!confirmIdle)throw new Error("Stop all existing Canonfig processes and schedules, then explicitly use --confirm-idle when enabling coordination for the first time.");
  const location=installation(root,home);npmCli=realpathSync(npmCli);
  if(!isAbsolute(npmCli)||!lstatSync(npmCli).isFile()||!npmCli.endsWith(`${sep}npm-cli.js`))throw new Error("--npm-cli must name the official installed npm/bin/npm-cli.js");
  const found=(await runner({executable:process.execPath,args:[npmCli,"root","--global","--prefix",location.prefix]},signal)).trim();
  if(signal?.aborted)throw new Error("Self-update cancelled");
  if(realpathSync(found)!==dirname(dirname(location.root)))throw new Error("npm global root does not match this installation");
  const directory=updateDirectory(location.root);mkdirSync(directory,{recursive:true,mode:0o700});
  if(lstatSync(directory).isSymbolicLink())throw new Error("Updater directory cannot be a symlink");
  const release=acquireGate(directory);
  try {
    if(existsSync(join(directory,"pending.json")))throw new Error("Interrupted self-update must be recovered before enabling");
    if(readersActive(directory))throw new Error("Cannot enable while Canonfig commands are active");
    if(existsSync(join(directory,"settings.json")))throw new Error("Self-updating is already configured; use status or disable first");
    const [major,minor]=parseVersion(location.version);const state=join(home,".canonfig","state.sqlite");assertNoUnfinishedRun(state);
    writeFileSync(join(directory,"settings.json"),JSON.stringify({version:1,root:location.root,prefix:location.prefix,npmCli,node:process.execPath,line:`${major}.${minor}`,state},null,2)+"\n",{flag:"wx",mode:0o600});
    syncFile(join(directory,"settings.json"));syncDirectory(directory);
  }finally{release();}
}
export function disable(root: string): void {
  const directory = updateDirectory(root);
  const release = acquireGate(directory);
  try {
    if (existsSync(join(directory, "pending.json")) || readersActive(directory)) {
      throw new Error("Cannot disable while commands or an interrupted transaction exist");
    }
    rmSync(join(directory, "settings.json"));
    syncDirectory(directory);
  } finally { release(); }
}

export type UpdateProgress =
  | { readonly phase: "checking"; readonly candidate: null }
  | { readonly phase: "staging" | "verifying" | "activating" | "complete"; readonly candidate: string };

const transactionFields = {
  version: Schema.Literal(2), operationId: Schema.String,
  root: Schema.String, backup: Schema.String, staged: Schema.String,
  previous: Schema.String, candidate: Schema.String,
};
const UpdateTransaction = Schema.Union([
  Schema.TaggedStruct("Staging", transactionFields),
  Schema.TaggedStruct("Verified", transactionFields),
  Schema.TaggedStruct("Prepared", transactionFields),
  Schema.TaggedStruct("OldMoved", transactionFields),
  Schema.TaggedStruct("Installed", transactionFields),
  Schema.TaggedStruct("Committed", transactionFields),
]);
type UpdateTransaction = typeof UpdateTransaction.Type;
export class UpdateTransitionError extends Schema.TaggedError<UpdateTransitionError>()(
  "UpdateTransitionError", { from: Schema.String, to: Schema.String },
) {}
const updateTransitions = {
  Staging: "Verified", Verified: "Prepared", Prepared: "OldMoved",
  OldMoved: "Installed", Installed: "Committed", Committed: undefined,
} satisfies Record<UpdateTransaction["_tag"], UpdateTransaction["_tag"] | undefined>;
const advanceUpdate = (state: UpdateTransaction, to: UpdateTransaction["_tag"]): UpdateTransaction => {
  if (updateTransitions[state._tag] !== to) throw new UpdateTransitionError({ from: state._tag, to });
  return { ...state, _tag: to };
};
const writeTransaction = (path: string, state: UpdateTransaction): void => {
  const temporary = `${path}.${state.operationId}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  syncFile(temporary); renameSync(temporary, path); syncDirectory(dirname(path));
};
export interface UpdateResult {current:string;candidate:string;status:"current"|"available"|"deferred"|"updated";detail:string}
export async function update(root:string,apply:boolean,runner:Runner=run,signal?:AbortSignal, home=homedir(), onProgress?: (progress: UpdateProgress) => void):Promise<UpdateResult>{
  if(signal?.aborted)throw new Error("Self-update cancelled");
  const location=installation(root,home);const directory=updateDirectory(location.root);const settings=readSettings(directory);
  const [major,minor]=parseVersion(location.version);
  if(settings.root!==location.root||settings.prefix!==location.prefix||settings.line!==`${major}.${minor}`||settings.node!==process.execPath||settings.state!==join(home,".canonfig","state.sqlite"))throw new Error("Installation, Node runtime or release line changed; disable and explicitly re-enable self-updating after review");
  if(existsSync(join(directory,"pending.json")))throw new Error("Interrupted self-update: preserve and inspect the pending journal and retained backup. No automatic takeover.");
  const operationId = randomUUID();
  const progress = (value: UpdateProgress) => {
    if (!apply) return;
    const path = join(directory, "progress.json");
    regular(path);
    const temporary = `${path}.${operationId}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 2, operationId, ...value }) + "\n", { flag: "wx", mode: 0o600 });
    syncFile(temporary); renameSync(temporary, path); syncDirectory(directory);
    onProgress?.(value);
  };
  const release = apply ? acquireGate(directory) : () => {};
  let committed: UpdateResult | undefined;
  const releaseGate = () => {
    try { release(); }
    catch(error) {
      if(!committed)throw error;
      committed.detail+=` Coordination cleanup also failed: ${error instanceof Error ? error.message : String(error)}. Preserve the updater gate for inspection.`;
    }
  };
  try {
  progress({phase:"checking", candidate:null});
  // Global mode ignores project .npmrc; isolated empty files ignore user/global
  // scope registries and credentials. The explicit scope override also wins
  // against npm defaults. The runner strips npm config/auth environment values.
  const isolated = ["empty-user.npmrc", "empty-global.npmrc"].map((name) => {
    const path=join(directory,name);
    if(!existsSync(path))writeFileSync(path,"",{flag:"wx",mode:0o600});
    regular(path);if(readFileSync(path,"utf8")!=="")throw new Error("Isolated npm configuration was modified");
    return path;
  });
  const common=["--global","--registry=https://registry.npmjs.org/","--@microck:registry=https://registry.npmjs.org/","--userconfig",isolated[0]!,"--globalconfig",isolated[1]!,"--cache",join(directory,"cache")];
  const raw=await runner({executable:settings.node,args:[settings.npmCli,"view","@microck/canonfig","versions","--json",...common]},signal);
  const versions=Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(raw);
  const candidate=latestPatch(location.version,versions);
  const result:UpdateResult={current:location.version,candidate,status:candidate===location.version?"current":"available",detail:"Only stable patches within the enabled major.minor line are eligible."};
  if(!apply||candidate===location.version) {
    progress({phase:"complete", candidate});
    return result;
  }
    if(existsSync(join(directory,"pending.json")))throw new Error("Interrupted self-update: preserve and inspect the pending journal and retained backup. No automatic takeover.");
    if(JSON.stringify(readSettings(directory))!==JSON.stringify(settings))throw new Error("Self-update settings changed while checking; no update applied");
    if(readersActive(directory)) {
      progress({phase:"complete", candidate});
      return {...result,status:"deferred",detail:"Canonfig commands are active (or left a stale lease). Retry after they finish; do not remove live leases."};
    }
    assertNoUnfinishedRun(settings.state);
    if(installation(root,home).version!==location.version)throw new Error("Installation changed during check");
    const token=operationId;const stage=join(directory,`stage-${token}`);const backup=join(directory,`backup-${location.version}-${token}`);
    mkdirSync(stage,{mode:0o700});
    const staged=join(stage,...(process.platform==="win32"?[]:["lib"]),"node_modules","@microck","canonfig");
    let transaction: UpdateTransaction = { _tag: "Staging", version: 2, operationId: token,
      root: location.root, backup, staged, previous: location.version, candidate };
    try {
    progress({phase:"staging", candidate});
    await runner({executable:settings.node,args:[settings.npmCli,"install","--global","--prefix",stage,"--install-strategy=nested","--ignore-scripts","--no-audit","--no-fund",`@microck/canonfig@${candidate}`,...common],timeout:900_000},signal);
    progress({phase:"verifying", candidate});
    const metadata=Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({name:Schema.Literal("@microck/canonfig"),version:Schema.String,dependencies:Schema.Record(Schema.String,Schema.String)})))(readFileSync(join(staged,"package.json"),"utf8"));
    if(metadata.name!=="@microck/canonfig"||metadata.version!==candidate||lstatSync(staged).isSymbolicLink())throw new Error("Staged package identity mismatch");
    const entry=join(staged,"dist","runtime","main.js");
    const require=createRequire(entry);
    for(const dependency of Object.keys(metadata.dependencies)) {
      const resolved=realpathSync(require.resolve(dependency));
      if(!within(resolved,staged))throw new Error(`Staged dependency is not self-contained: ${dependency}`);
    }
    const printed=(await runner({executable:settings.node,args:[entry,"--version"]},signal)).trim();
    if(printed!==candidate)throw new Error("Staged CLI version verification failed");
    await runner({executable:settings.node,args:[entry,"self-update","--help"]},signal);
    if(signal?.aborted)throw new Error("Self-update cancelled before activation");
    assertNoUnfinishedRun(settings.state);
    if(readersActive(directory)||installation(root,home).version!==location.version)throw new Error("Installation became busy or changed before activation");
    transaction = advanceUpdate(transaction, "Verified");
    const journal=join(directory,"pending.json");
    transaction = advanceUpdate(transaction, "Prepared"); writeTransaction(journal, transaction);
    progress({phase:"activating", candidate});
    renameSync(location.root,backup); transaction = advanceUpdate(transaction, "OldMoved"); writeTransaction(journal, transaction);
    syncDirectory(dirname(location.root));syncDirectory(directory);
    // A failed second rename deliberately retains the gate/journal evidence for
    // operator recovery; never delete the old package or pretend it succeeded.
    renameSync(staged,location.root); transaction = advanceUpdate(transaction, "Installed");
    writeTransaction(journal, transaction);syncDirectory(dirname(location.root));
    transaction = advanceUpdate(transaction, "Committed");writeTransaction(journal, transaction);
    renameSync(journal,join(directory,"last-transaction.json"));syncDirectory(directory);
    committed={...result,status:"updated",detail:`Retained previous package at ${backup}. Restart this updater under the new build; refresh managed follower bindings with sync --apply. No service was restarted.`};
    progress({phase:"complete", candidate});
    return committed;
    } catch(error) {
      // Installation is irreversible here, even if its receipt is not durable.
      // Never turn a bookkeeping error into permission for the old process to resume.
      if(transaction._tag==="Installed"||transaction._tag==="Committed") {
        committed={...result,status:"updated",detail:`The candidate is installed, but update bookkeeping failed: ${error instanceof Error ? error.message : String(error)}. Restart under the new build. Preserve ${directory} and inspect any pending journal before running commands. Retained previous package at ${backup}. No service was restarted.`};
        return committed;
      }
      // A pending journal (even partial) owns recovery evidence. Only discard
      // staging when no transaction could have moved the installed package.
      if(transaction._tag==="Staging"||transaction._tag==="Verified")rmSync(stage,{recursive:true,force:true});
      throw error;
    }
  }finally{releaseGate();}
}
