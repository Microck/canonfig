import { Schema } from "effect";
import { readSettings } from "./settings.ts";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, openSync, closeSync, fsyncSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { acquireGate, readersActive, regular, updateDirectory } from "./coordination.ts";

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
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/iu.test(key) && !["NPM_TOKEN","NODE_AUTH_TOKEN","NODE_OPTIONS"].includes(key.toUpperCase())));
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
  if(process.getuid && (lstatSync(prefix).uid!==process.getuid() || lstatSync(root).uid!==process.getuid() || ((lstatSync(prefix).mode|lstatSync(root).mode)&0o022)!==0))throw new Error("npm prefix/package must be user-owned and not writable by other users");
  const expected=join(prefix,...(process.platform==="win32"?[]:["lib"]),"node_modules","@microck","canonfig");
  if(root!==expected||!within(prefix,home))throw new Error("Self-update only supports a user-private global npm prefix under your home; system, project and linked installs require manual updates");
  return {root,prefix,version:manifest.version};
}
export function assertNoUnfinishedRun(state: string): void {
  if(!existsSync(state))return;
  regular(state);
  const db=new DatabaseSync(state,{readOnly:true});
  try {
    const row=db.prepare("SELECT id FROM synchronization_runs WHERE status IN ('applying', 'Interrupted') LIMIT 1").get();
    if(row)throw new Error("An unfinished sync exists. Finish or recover it with the current build before updating.");
  } finally {db.close();}
}
function syncFile(path: string): void {const fd=openSync(path,"r+");try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncDirectory(path:string):void {if(process.platform!=="win32"){const fd=openSync(path,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}}
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
    if(existsSync(join(directory,"settings.json")))throw new Error("Self-updating is already configured; use status or disable first");
    const [major,minor]=parseVersion(location.version);const state=join(home,".canonfig","state.sqlite");assertNoUnfinishedRun(state);
    writeFileSync(join(directory,"settings.json"),JSON.stringify({version:1,root:location.root,prefix:location.prefix,npmCli,node:process.execPath,line:`${major}.${minor}`,state},null,2)+"\n",{flag:"wx",mode:0o600});
    syncFile(join(directory,"settings.json"));syncDirectory(directory);
  }finally{release();}
}
export interface UpdateResult {current:string;candidate:string;status:"current"|"available"|"deferred"|"updated";detail:string}
export async function update(root:string,apply:boolean,runner:Runner=run,signal?:AbortSignal, home=homedir()):Promise<UpdateResult>{
  if(signal?.aborted)throw new Error("Self-update cancelled");
  const location=installation(root,home);const directory=updateDirectory(location.root);const settings=readSettings(directory);
  const [major,minor]=parseVersion(location.version);
  if(settings.root!==location.root||settings.prefix!==location.prefix||settings.line!==`${major}.${minor}`||settings.node!==process.execPath||settings.state!==join(home,".canonfig","state.sqlite"))throw new Error("Installation, Node runtime or release line changed; disable and explicitly re-enable self-updating after review");
  if(existsSync(join(directory,"pending.json")))throw new Error("Interrupted self-update: preserve and inspect the pending journal and retained backup. No automatic takeover.");
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
  if(!apply||candidate===location.version)return result;
  const release=acquireGate(directory);
  try {
    if(JSON.stringify(readSettings(directory))!==JSON.stringify(settings))throw new Error("Self-update settings changed while checking; no update applied");
    if(readersActive(directory))return {...result,status:"deferred",detail:"Canonfig commands are active (or left a stale lease). Retry after they finish; do not remove live leases."};
    assertNoUnfinishedRun(settings.state);
    if(installation(root,home).version!==location.version)throw new Error("Installation changed during check");
    const token=randomUUID();const stage=join(directory,`stage-${token}`);const backup=join(directory,`backup-${location.version}-${token}`);
    mkdirSync(stage,{mode:0o700});
    await runner({executable:settings.node,args:[settings.npmCli,"install","--global","--prefix",stage,"--install-strategy=nested","--ignore-scripts","--no-audit","--no-fund",`@microck/canonfig@${candidate}`,...common],timeout:900_000},signal);
    const staged=join(stage,...(process.platform==="win32"?[]:["lib"]),"node_modules","@microck","canonfig");
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
    const journal=join(directory,"pending.json");
    writeFileSync(journal,JSON.stringify({version:1,root,backup,staged,previous:location.version,candidate},null,2)+"\n",{flag:"wx",mode:0o600});syncFile(journal);syncDirectory(directory);
    renameSync(root,backup);syncDirectory(dirname(root));syncDirectory(directory);
    // A failed second rename deliberately retains the gate/journal evidence for
    // operator recovery; never delete the old package or pretend it succeeded.
    renameSync(staged,root);syncDirectory(dirname(root));
    renameSync(journal,join(directory,"last-transaction.json"));syncDirectory(directory);
    return {...result,status:"updated",detail:`Retained previous package at ${backup}. Restart this updater under the new build; refresh managed follower bindings with sync --apply. No service was restarted.`};
  }finally{release();}
}
