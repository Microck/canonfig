import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, realpathSync, symlinkSync, lstatSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disable, enable, installation, latestPatch, parseVersion, update, assertNoUnfinishedRun, run, type Runner, type UpdateProgress } from "../../src/runtime/self-update/core.ts";
import { commandLease, managedCommandLease, updateDirectory, acquireGate } from "../../src/runtime/self-update/coordination.ts";
import { runSelfUpdateCli } from "../../src/runtime/self-update/cli.ts";
import { Effect, Fiber } from "effect";
import { runCancellablePromise } from "../../src/runtime/cancellable-promise.ts";

const roots:string[]=[];
afterEach(()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const home=realpathSync(mkdtempSync(join(tmpdir(),"canonfig-self-update-")));roots.push(home);
 const prefix=join(home,"prefix");const packageAt=(prefix:string)=>join(prefix,...(process.platform==="win32"?[]:["lib"]),"node_modules","@microck","canonfig");
 const root=packageAt(prefix);const npmCli=join(home,"npm","bin","npm-cli.js");
 const put=(where:string,version:string)=>{mkdirSync(join(where,"dist","runtime"),{recursive:true});writeFileSync(join(where,"package.json"),JSON.stringify({name:"@microck/canonfig",version,bin:{canonfig:"dist/runtime/main.js"},dependencies:{}}));writeFileSync(join(where,"dist","runtime","main.js"),"// fixture only\n");};
 put(root,"4.2.0");mkdirSync(dirname(npmCli),{recursive:true});writeFileSync(npmCli,"// never executed\n");
 const calls:ReadonlyArray<string>[]=[];
 const runner:Runner=async({args})=>{
  calls.push(args);
  if(args[1]==="root")return dirname(dirname(root));
  if(args[1]==="view")return '["4.2.0","4.2.1","4.3.0","5.0.0","4.2.2-beta.1"]';
  if(args[1]==="install") {const stage=args[args.indexOf("--prefix")+1]!;put(packageAt(stage),"4.2.1");return "";}
  if(args[1]==="--version")return "4.2.1\n";
  return "self-update help\n";
 };
 return {home,prefix,root,npmCli,runner,calls,packageAt,put};
}
describe("self-update policy and package activation",()=>{
 it("isolates npm config, credentials and Node injection from subprocesses",async()=>{
  vi.stubEnv("NPM_CONFIG_REGISTRY","https://invalid.example/");vi.stubEnv("NPM_TOKEN","fixture-token");vi.stubEnv("NODE_AUTH_TOKEN","fixture-auth");vi.stubEnv("NODE_OPTIONS","--no-warnings");
  const text=await run({executable:process.execPath,args:["-e","console.log(JSON.stringify(Object.keys(process.env).filter(k=>/^npm_config_/i.test(k)||['NPM_TOKEN','NODE_AUTH_TOKEN','NODE_OPTIONS'].includes(k))))"]});
  expect(text.trim()).toBe("[]");
 });
 it("selects stable forward patches only",()=>{
  expect(latestPatch("4.2.5",["4.2.4","4.2.6","4.2.7-rc.1","4.3.0","5.0.0"])).toBe("4.2.6");
  expect(latestPatch("4.2.5",["4.3.0"])).toBe("4.2.5");
  for(const invalid of ["latest","v4.2.0","4.2.0-beta","04.2.0","4.2.9007199254740992"])expect(()=>parseVersion(invalid)).toThrow();
 });
 it("refuses non-private, non-global and checkout installations",()=>{
  const f=fixture();expect(installation(f.root,f.home).prefix).toBe(f.prefix);
  expect(()=>installation(f.root,join(f.home,"prefix"))).toThrow();
  const local=join(f.home,"project","node_modules","@microck","canonfig");f.put(local,"4.2.0");
  if(process.platform!=="win32")expect(()=>installation(local,f.home)).toThrow();
 });
 it("requires first-enable idle acknowledgement and does no install",async()=>{
  const f=fixture();await expect(enable(f.root,f.npmCli,false,f.runner,f.home)).rejects.toThrow("confirm-idle");
  await enable(f.root,f.npmCli,true,f.runner,f.home);
  expect(f.calls.every(args=>!args.includes("install"))).toBe(true);
  await expect(enable(f.root,f.npmCli,true,f.runner,f.home)).rejects.toThrow("already configured");
 });
 it("does not persist enable after cancellation during npm root discovery",async()=>{
  const f=fixture();const controller=new AbortController();
  const runner:Runner=async(input,signal)=>{expect(signal).toBe(controller.signal);const result=await f.runner(input,signal);controller.abort();return result;};
  await expect(enable(f.root,f.npmCli,true,runner,f.home,controller.signal)).rejects.toThrow("cancelled");
  expect(existsSync(join(updateDirectory(f.root),"settings.json"))).toBe(false);
 });
 it("previews without activation, then retains the old package and receipt",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  expect((await update(f.root,false,f.runner,undefined,f.home)).status).toBe("available");
  expect(installation(f.root,f.home).version).toBe("4.2.0");
  const result=await update(f.root,true,f.runner,undefined,f.home);expect(result.status).toBe("updated");
  expect(installation(f.root,f.home).version).toBe("4.2.1");
  const dir=updateDirectory(f.root);expect(existsSync(join(dir,"pending.json"))).toBe(false);
  const backups=readdirSync(dir).filter(n=>n.startsWith("backup-"));expect(backups).toHaveLength(1);
  expect(readFileSync(join(dir,backups[0]!,"package.json"),"utf8")).toContain("4.2.0");
  expect(existsSync(join(dir,"last-transaction.json"))).toBe(true);
  const install=f.calls.find(args=>args[1]==="install")!;
  expect(install).toContain("--@microck:registry=https://registry.npmjs.org/");
  expect(install).toContain("--userconfig");expect(install).toContain("--globalconfig");
  const view=f.calls.find(args=>args[1]==="view")!;expect(view).toContain("--global");expect(view).toContain("--@microck:registry=https://registry.npmjs.org/");
  expect(install).toContain("--ignore-scripts");expect(install).toContain("--install-strategy=nested");expect(install).toContain("@microck/canonfig@4.2.1");
 });
 it("defers for active readers and blocks new readers under the updater gate",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const release=commandLease(f.root)!;
  expect((await update(f.root,true,f.runner,undefined,f.home)).status).toBe("deferred");release();
  const gate=acquireGate(updateDirectory(f.root));expect(()=>commandLease(f.root)).toThrow("busy");gate();
  expect((await update(f.root,true,f.runner,undefined,f.home)).status).toBe("updated");
 });
 it.each([
  ["live PID regardless of age", JSON.stringify({pid:process.pid,started:"1970-01-01T00:00:00.000Z"})],
  ["malformed JSON", "{"],
  ["invalid PID", JSON.stringify({pid:-1})],
  ["mismatched PID", JSON.stringify({pid:process.pid+1})],
 ])("retains a reader with %s",async(_description,record)=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const readers=join(updateDirectory(f.root),"readers");mkdirSync(readers,{recursive:true});
  const path=join(readers,`${process.pid}-retained.json`);writeFileSync(path,record);
  expect((await update(f.root,true,f.runner,undefined,f.home)).status).toBe("deferred");
  expect(()=>disable(f.root)).toThrow("Cannot disable");
  expect(readFileSync(path,"utf8")).toBe(record);
 });
 it("registers its own lease after enabling and removes it when disabling",async()=>{
  const f=fixture();const lease=managedCommandLease(f.root);const readers=join(updateDirectory(f.root),"readers");
  try {
   await lease.selfUpdate(()=>enable(f.root,f.npmCli,true,f.runner,f.home),()=>true);
   expect(readdirSync(readers)).toHaveLength(1);
   await lease.selfUpdate(async()=>disable(f.root),()=>true);
   expect(readdirSync(readers)).toEqual([]);
   expect(existsSync(join(updateDirectory(f.root),"settings.json"))).toBe(false);
   expect(lease.suspended).toBe(false);
  } finally {lease.close();}
 });
 it("suspends only its own reader and reacquires after a deferred update or failure",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const lease=managedCommandLease(f.root);const readers=join(updateDirectory(f.root),"readers");
  const own=readdirSync(readers)[0];const releaseOther=commandLease(f.root)!;
  const other=readdirSync(readers).find(name=>name!==own);
  try {
   const result=await lease.selfUpdate(async()=>{
    expect(lease.suspended).toBe(true);
    expect(readdirSync(readers)).toEqual([other]);
    return update(f.root,true,f.runner,undefined,f.home);
   },result=>result.status!=="updated");
   expect(result.status).toBe("deferred");expect(lease.suspended).toBe(false);
   expect(readdirSync(readers)).toContain(other);expect(readdirSync(readers)).toHaveLength(2);
   await expect(lease.selfUpdate(async()=>disable(f.root),()=>true)).rejects.toThrow("Cannot disable while commands or an interrupted transaction exist");
   expect(readdirSync(readers)).toContain(other);expect(readdirSync(readers)).toHaveLength(2);
   releaseOther();
   expect((await lease.selfUpdate(()=>update(f.root,true,f.runner,undefined,f.home),result=>result.status!=="updated")).status).toBe("updated");
   expect(readdirSync(readers)).toEqual([]);
  } finally {releaseOther();lease.close();}
 });
 it("does not bypass a pending transaction when reacquiring after failure",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);const lease=managedCommandLease(f.root);
  try {
   await expect(lease.selfUpdate(async()=>{
    writeFileSync(join(updateDirectory(f.root),"pending.json"),"{}");
    throw new Error("activation interrupted");
   },()=>true)).rejects.toThrow("activation interrupted");
   expect(lease.suspended).toBe(true);
   await expect(lease.selfUpdate(async()=>undefined,()=>true)).rejects.toThrow("already stopping or performing");
   expect(readdirSync(join(updateDirectory(f.root),"readers"))).toEqual([]);
   expect(existsSync(join(updateDirectory(f.root),"pending.json"))).toBe(true);
  } finally {lease.close();}
 });
 it("refuses concurrent handoffs and never reacquires after close during a handoff",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);const lease=managedCommandLease(f.root);
  const finished=Promise.withResolvers<void>();
  const operation=lease.selfUpdate(()=>finished.promise,()=>true);
  try {
   expect(lease.suspended).toBe(true);
   await expect(lease.selfUpdate(async()=>undefined,()=>true)).rejects.toThrow("already stopping or performing");
   lease.close();finished.resolve();await operation;
   expect(readdirSync(join(updateDirectory(f.root),"readers"))).toEqual([]);
   await expect(lease.selfUpdate(async()=>undefined,()=>true)).rejects.toThrow("already stopping or performing");
  } finally {finished.resolve();await operation;lease.close();}
 });
 it("reports each update phase only after its progress record is persisted",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const progress:UpdateProgress[]=[];
  const result=await update(f.root,true,f.runner,undefined,f.home,value=>{
   expect(JSON.parse(readFileSync(join(updateDirectory(f.root),"progress.json"),"utf8"))).toMatchObject({version:2,operationId:expect.any(String),...value});
   progress.push(value);
  });
  expect(result.status).toBe("updated");
  expect(progress).toEqual([
   {phase:"checking",candidate:null},
   {phase:"staging",candidate:"4.2.1"},
   {phase:"verifying",candidate:"4.2.1"},
   {phase:"activating",candidate:"4.2.1"},
   {phase:"complete",candidate:"4.2.1"},
  ]);
  const receipt=JSON.parse(readFileSync(join(updateDirectory(f.root),"last-transaction.json"),"utf8"));
  const persisted=JSON.parse(readFileSync(join(updateDirectory(f.root),"progress.json"),"utf8"));
  expect(receipt).toMatchObject({_tag:"Committed",version:2,operationId:persisted.operationId});
 });
 it.each(["receipt", "progress", "progress-file"] as const)("keeps restart-required semantics after a committed %s failure",async(failure)=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const lease=managedCommandLease(f.root);const directory=updateDirectory(f.root);
  try {
   const result=await lease.selfUpdate(()=>update(f.root,true,f.runner,undefined,f.home,value=>{
    if(failure==="receipt"&&value.phase==="activating")mkdirSync(join(directory,"last-transaction.json"));
    if(failure==="progress-file"&&value.phase==="activating") {
     rmSync(join(directory,"progress.json"));mkdirSync(join(directory,"progress.json"));
    }
    if(failure==="progress"&&value.phase==="complete")throw new Error("progress delivery failed");
   }),value=>value.status!=="updated");
   expect(result.status).toBe("updated");
   expect(result.detail).toContain("bookkeeping");
   expect(installation(f.root,f.home).version).toBe("4.2.1");
   expect(lease.suspended).toBe(true);
   expect(readdirSync(join(directory,"readers"))).toEqual([]);
   expect(readdirSync(directory).some(name=>name.startsWith("backup-"))).toBe(true);
   await expect(lease.selfUpdate(async()=>undefined,()=>true)).rejects.toThrow("already stopping");
  } finally {lease.close();}
 });
 it("refuses unfinished and unreadable synchronization state without installing",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const state=join(f.home,".canonfig","state.sqlite");mkdirSync(dirname(state),{recursive:true});
  const db=new DatabaseSync(state);db.exec("CREATE TABLE synchronization_runs (id TEXT,status TEXT); INSERT INTO synchronization_runs VALUES ('old','Interrupted')");db.close();
  await expect(update(f.root,true,f.runner,undefined,f.home)).rejects.toThrow("unfinished");
  expect(f.calls.some(args=>args[1]==="install")).toBe(false);
  rmSync(state);writeFileSync(state,"not sqlite");expect(()=>assertNoUnfinishedRun(state)).toThrow();
 });
 it.each(["Preparing","Applying","Interrupted","Finalizing","Complete"])("reads migrated synchronization phase %s before updating",(phase)=>{
  const f=fixture();const state=join(f.home,"state.sqlite");
  const db=new DatabaseSync(state);
  try {
   db.exec("CREATE TABLE synchronization_runs (id TEXT, phase TEXT)");
   db.prepare("INSERT INTO synchronization_runs VALUES (?, ?)").run("run",phase);
  } finally {db.close();}
  if(phase==="Complete")expect(()=>assertNoUnfinishedRun(state)).not.toThrow();
  else expect(()=>assertNoUnfinishedRun(state)).toThrow("unfinished");
 });
 it("honors disable while a registry query is in flight",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const runner:Runner=async(input,signal)=>{const result=await f.runner(input,signal);if(input.args[1]==="view")rmSync(join(updateDirectory(f.root),"settings.json"));return result;};
  await expect(update(f.root,true,runner,undefined,f.home)).rejects.toThrow();
  expect(f.calls.some(args=>args[1]==="install")).toBe(false);
  expect(installation(f.root,f.home).version).toBe("4.2.0");
 });
 it("keeps the old install after staging failure",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const runner:Runner=(input,signal)=>input.args[1]==="install"?Promise.reject(new Error("offline")):f.runner(input,signal);
  await expect(update(f.root,true,runner,undefined,f.home)).rejects.toThrow("offline");
  expect(installation(f.root,f.home).version).toBe("4.2.0");expect(existsSync(join(updateDirectory(f.root),"pending.json"))).toBe(false);
  expect(readdirSync(updateDirectory(f.root)).some(n=>n.startsWith("stage-"))).toBe(false);
 });
 it("rejects escaping staged dependencies and removes only pre-journal staging",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const runner:Runner=async(input,signal)=>{
   const result=await f.runner(input,signal);
   if(input.args[1]==="install"){
    const staged=f.packageAt(input.args[input.args.indexOf("--prefix")+1]!);
    writeFileSync(join(staged,"package.json"),JSON.stringify({name:"@microck/canonfig",version:"4.2.1",dependencies:{outside:"1.0.0"}}));
    const foreign=join(dirname(dirname(staged)),"outside");mkdirSync(foreign);writeFileSync(join(foreign,"index.js"),"module.exports = {};\n");
   }return result;
  };
  await expect(update(f.root,true,runner,undefined,f.home)).rejects.toThrow("not self-contained");
  expect(installation(f.root,f.home).version).toBe("4.2.0");
  expect(readdirSync(updateDirectory(f.root)).some(n=>n.startsWith("stage-"))).toBe(false);
 });
 it("activates the canonical package instead of moving a directory alias",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const alias=join(f.home,"alias");symlinkSync(f.root,alias,process.platform==="win32"?"junction":"dir");
  expect((await update(alias,true,f.runner,undefined,f.home)).status).toBe("updated");
  expect(lstatSync(alias).isSymbolicLink()).toBe(true);expect(installation(f.root,f.home).version).toBe("4.2.1");
 });
 it("blocks commands when settings were removed but recovery is pending",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);const dir=updateDirectory(f.root);
  rmSync(join(dir,"settings.json"));writeFileSync(join(dir,"pending.json"),"{}");
  expect(()=>commandLease(f.root)).toThrow("Interrupted");
 });
 it.skipIf(process.platform==="win32")("refuses dangling settings links and writable coordination directories",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);const dir=updateDirectory(f.root);
  chmodSync(dir,0o770);expect(()=>acquireGate(dir)).toThrow("not writable");chmodSync(dir,0o700);
  rmSync(join(dir,"settings.json"));symlinkSync(join(dir,"missing"),join(dir,"settings.json"));
  expect(()=>commandLease(f.root)).toThrow("regular file");
 });
 it.skipIf(process.platform==="win32")("rejects writable ancestors and state before any npm invocation",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);f.calls.length=0;
  const parent=dirname(f.root);chmodSync(parent,0o777);
  await expect(update(f.root,false,f.runner,undefined,f.home)).rejects.toThrow("not writable");expect(f.calls).toHaveLength(0);chmodSync(parent,0o755);
  const dir=updateDirectory(f.root);chmodSync(dir,0o777);
  await expect(update(f.root,false,f.runner,undefined,f.home)).rejects.toThrow("not writable");expect(f.calls).toHaveLength(0);chmodSync(dir,0o700);
  chmodSync(join(dir,"settings.json"),0o666);
  await expect(update(f.root,false,f.runner,undefined,f.home)).rejects.toThrow("not writable");expect(f.calls).toHaveLength(0);
 });
 it("emits the standard JSON envelope for help, status and usage failures",async()=>{
  let out="",err="";const io={writeStdout:(s:string)=>{out+=s;},writeStderr:(s:string)=>{err+=s;},setExitCode:()=>{}};
  await runSelfUpdateCli(["--json","--help"],"/missing",io);
  expect(JSON.parse(out)).toMatchObject({schema:"canonfig.cli/v1",command:"self-update.help",status:"success",exitCode:0});
  out="";await runSelfUpdateCli(["status","--json"],"/missing",io);expect(JSON.parse(out)).toMatchObject({schema:"canonfig.cli/v1",command:"self-update.status",data:{enabled:false}});
  await runSelfUpdateCli(["--json","unknown"],"/missing",io);expect(JSON.parse(err)).toMatchObject({schema:"canonfig.cli/v1",status:"error",exitCode:2});
 });
 it("retains recovery evidence when activation is interrupted after backup",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  let staged="";const runner:Runner=async(input,signal)=>{
   const result=await f.runner(input,signal);
   if(input.args[1]==="install")staged=f.packageAt(input.args[input.args.indexOf("--prefix")+1]!);
   if(input.args[1]==="self-update")rmSync(staged,{recursive:true});
   return result;
  };
  await expect(update(f.root,true,runner,undefined,f.home)).rejects.toThrow();
  const dir=updateDirectory(f.root);expect(existsSync(join(dir,"pending.json"))).toBe(true);
  expect(readdirSync(dir).some(n=>n.startsWith("backup-"))).toBe(true);
  expect(()=>commandLease(f.root)).toThrow("Interrupted");
 });
 it("refuses changed release line and cancelled activation",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  f.put(f.root,"4.3.0");await expect(update(f.root,true,f.runner,undefined,f.home)).rejects.toThrow("release line");
  f.put(f.root,"4.2.0");const c=new AbortController();c.abort();
  await expect(update(f.root,true,f.runner,c.signal,f.home)).rejects.toThrow("cancelled");
  expect(installation(f.root,f.home).version).toBe("4.2.0");
 });
 it("renders help without touching installation/state and rejects unsafe flags",async()=>{
  let out="",err="",code=0;const io={writeStdout:(s:string)=>{out+=s;},writeStderr:(s:string)=>{err+=s;},setExitCode:(n:number)=>{code=n;}};
  await runSelfUpdateCli(["--help"],"/missing",io);expect(out).toContain("patch");expect(code).toBe(0);
  for(const args of [["auto","--interval","1"],["apply","--once"],["check","--apply"],["auto","--force"]]){code=0;await runSelfUpdateCli(args,"/missing",io);expect(code).toBe(2);}
  expect(err.length).toBeGreaterThan(0);
 });
 // `self-update` runs under runCancellablePromise: interruption must wait for its cleanup.
 it("Effect interruption waits for an in-flight command to finish cleanup",async()=>{
  const started=Promise.withResolvers<void>();const cancelled=Promise.withResolvers<void>();const release=Promise.withResolvers<void>();let cleaned=false;
  const fiber=Effect.runFork(runCancellablePromise(async signal=>{
   signal.addEventListener("abort",()=>cancelled.resolve(),{once:true});started.resolve();
   await cancelled.promise;await release.promise;cleaned=true;
  }));
  await started.promise;const interruption=Effect.runPromise(Fiber.interrupt(fiber));
  await cancelled.promise;expect(cleaned).toBe(false);release.resolve();await interruption;expect(cleaned).toBe(true);
 });
});
