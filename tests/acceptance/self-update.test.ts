import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { enable, installation, latestPatch, parseVersion, update, assertNoUnfinishedRun, run, type Runner } from "../../src/runtime/self-update/core.ts";
import { commandLease, updateDirectory, acquireGate } from "../../src/runtime/self-update/coordination.ts";
import { runSelfUpdateCli } from "../../src/runtime/self-update/cli.ts";

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
 it("refuses unfinished and unreadable synchronization state without installing",async()=>{
  const f=fixture();await enable(f.root,f.npmCli,true,f.runner,f.home);
  const state=join(f.home,".canonfig","state.sqlite");mkdirSync(dirname(state),{recursive:true});
  const db=new DatabaseSync(state);db.exec("CREATE TABLE synchronization_runs (id TEXT,status TEXT); INSERT INTO synchronization_runs VALUES ('old','Interrupted')");db.close();
  await expect(update(f.root,true,f.runner,undefined,f.home)).rejects.toThrow("unfinished");
  expect(f.calls.some(args=>args[1]==="install")).toBe(false);
  rmSync(state);writeFileSync(state,"not sqlite");expect(()=>assertNoUnfinishedRun(state)).toThrow();
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
});
