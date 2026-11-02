import { spawn } from "node:child_process";
import { Effect, Fiber } from "effect";
import { runCancellablePromise } from "../../src/runtime/cancellable-promise.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { watchHarness, type HarnessWatchPass } from "../../src/harness-configuration/watch.ts";
import { HarnessConfigurationCompiler, createDefaultRegistry } from "../../src/harness-configuration/core/compiler.ts";
import { applyPlan } from "../../src/harness-configuration/core/planner.ts";
import { parseHarnessArguments } from "../../src/harness-configuration/cli-arguments.ts";
import { runHarnessConfigurationCli } from "../../src/harness-configuration/cli.ts";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
const compiler=new HarnessConfigurationCompiler(createDefaultRegistry());
async function fixture(){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"canonfig-watch-")));roots.push(root);
 await fs.mkdir(path.join(root,".canonfig","instructions"),{recursive:true});
 await fs.mkdir(path.join(root,".canonfig","skills","sample"),{recursive:true});
 await fs.writeFile(path.join(root,".canonfig","skills","sample","SKILL.md"),"---\nname: sample\ndescription: Sample skill\n---\n# Sample\n");
 await fs.writeFile(path.join(root,".canonfig","harness.json"),JSON.stringify({version:1,project:{name:"watch"},targets:{codex:{enabled:true},"oh-my-pi":{enabled:true}},instructions:{root:"instructions/AGENTS.md"},skills:{roots:["skills"]},mcp:{servers:{docs:{transport:"stdio",command:"node",args:["server.js"]}}}}));
 const source=path.join(root,".canonfig","instructions","AGENTS.md");await fs.writeFile(source,"# First\n");
 return {root,source,strict:false,dryRun:false,interval:1};
}
it("applies canonical edits and skill changes, and recreates deleted output",async()=>{
 const options=await fixture();const control=new AbortController();let polls=0;let applied=0;let active=0;
 await watchHarness(options,pass=>{expect(pass.blocked).toBe(false);if(pass.applied)applied++;},control.signal,{
  plan:async input=>{expect(active++).toBe(0);try{return await compiler.plan(input);}finally{active--; }},apply:applyPlan,
  pause:async()=>{
   polls++;
   if(polls===2){expect(await fs.readFile(path.join(options.root,"AGENTS.md"),"utf8")).toContain("First");await fs.writeFile(options.source,"# Second\n");}
   if(polls===4){expect(await fs.readFile(path.join(options.root,"AGENTS.md"),"utf8")).toContain("Second");await fs.appendFile(path.join(options.root,".canonfig","skills","sample","SKILL.md"),"Updated skill\n");}
   if(polls===6){expect(await fs.readFile(path.join(options.root,".agents","skills","sample","SKILL.md"),"utf8")).toContain("Updated skill");await fs.rm(path.join(options.root,"AGENTS.md"));}
   if(polls===8)control.abort();
   if(polls>10)throw new Error("Watch failed to stop");
  }
 });
 expect(applied).toBe(4);expect(await fs.readFile(path.join(options.root,"AGENTS.md"),"utf8")).toContain("Second");
 await expect(fs.stat(path.join(options.root,".canonfig",".harness-watch.lock"))).rejects.toMatchObject({code:"ENOENT"});
});
it("coalesces changing plans, performs no idle state rewrites, and previews without writes",async()=>{
 const options=await fixture();const control=new AbortController();let polls=0;let writes=0;let reports=0;
 await watchHarness({...options,dryRun:true},()=>{reports++;},control.signal,{
  plan:input=>compiler.plan(input),apply:async()=>{writes++;},pause:async()=>{
   polls++;if(polls===1)await fs.writeFile(options.source,"# During save\n");if(polls===5)control.abort();
  }
 });
 expect(writes).toBe(0);expect(reports).toBe(1);
 await expect(fs.stat(path.join(options.root,"AGENTS.md"))).rejects.toMatchObject({code:"ENOENT"});
 await expect(fs.stat(path.join(options.root,".canonfig",".harness-watch.lock"))).rejects.toMatchObject({code:"ENOENT"});
});
it("stops on native drift rather than overwriting it",async()=>{
 const options=await fixture();const control=new AbortController();let polls=0;const passes:HarnessWatchPass[]=[];
 await watchHarness(options,pass=>passes.push(pass),control.signal,{plan:input=>compiler.plan(input),apply:applyPlan,pause:async()=>{
  if(++polls===2)await fs.writeFile(path.join(options.root,".agents","skills","sample","SKILL.md"),"# edited locally\n");
  if(polls>5)throw new Error("Did not stop on conflict");
 }});
 expect(passes.at(-1)?.blocked).toBe(true);expect(await fs.readFile(path.join(options.root,".agents","skills","sample","SKILL.md"),"utf8")).toBe("# edited locally\n");
});
it("refuses a second writer and removes its lock after a compiler failure",async()=>{
 const options=await fixture();const control=new AbortController();const lock=path.join(options.root,".canonfig",".harness-watch.lock");
 await fs.writeFile(lock,"");await expect(watchHarness(options,()=>undefined,control.signal)).rejects.toThrow("Another watcher");await fs.unlink(lock);
 await expect(watchHarness(options,()=>undefined,control.signal,{plan:async()=>{throw new Error("Invalid source");},apply:applyPlan,pause:async()=>undefined})).rejects.toThrow("Invalid source");
 await expect(fs.stat(lock)).rejects.toMatchObject({code:"ENOENT"});
});
it("does not write after cancellation during compilation",async()=>{
 const options=await fixture();const control=new AbortController();let writes=0;
 await watchHarness(options,()=>{throw new Error("No report expected");},control.signal,{plan:async input=>{const plan=await compiler.plan(input);control.abort();return plan;},apply:async()=>{writes++;},pause:async()=>undefined});
 expect(writes).toBe(0);
});
it("validates watch interval and rejects force",()=>{
 expect(parseHarnessArguments(["watch"]).interval).toBe(1);
 for(const args of [["watch","--force"],["apply","--interval","2"],["watch","--interval","0"],["watch","--interval","1.5"],["watch","--interval","1","--interval","2"]])expect(()=>parseHarnessArguments(args)).toThrow();
});
it("runs the real CLI watcher with JSON output and cancellation",async()=>{
 const options=await fixture();const control=new AbortController();const output:string[]=[];let exit=-1;
 await runHarnessConfigurationCli(["watch","--root",options.root,"--json"],{writeStdout:value=>{output.push(value);control.abort();},writeStderr:value=>{throw new Error(value);},setExitCode:code=>{exit=code;}},control.signal);
 expect(exit).toBe(0);expect(output.join("")).toContain("harness.watch");expect(await fs.readFile(path.join(options.root,"AGENTS.md"),"utf8")).toContain("First");
});

it("does not rewrite generated files or ownership state while idle",async()=>{
 const options=await fixture();const control=new AbortController();let polls=0;let writes=0;
 await watchHarness(options,()=>undefined,control.signal,{plan:input=>compiler.plan(input),apply:async plan=>{writes++;await applyPlan(plan);},pause:async()=>{if(++polls===8)control.abort();}});
 expect(writes).toBe(1);
});
it("propagates MCP edits to both selected harnesses",async()=>{
 const options=await fixture();const control=new AbortController();let polls=0;
 const config=path.join(options.root,".canonfig","harness.json");
 await watchHarness(options,()=>undefined,control.signal,{plan:input=>compiler.plan(input),apply:applyPlan,pause:async()=>{
  if(++polls===2)await fs.writeFile(config,(await fs.readFile(config,"utf8")).replace("server.js","new-server.js"));
  if(polls===4)control.abort();
 }});
 const plan=await compiler.plan({root:options.root});
 expect(plan.entries.some(entry=>entry.action==="update")).toBe(false);
 const projected=plan.entries.filter(entry=>entry.path.includes(".codex")||entry.path.includes(".omp"));
 expect(projected.filter(entry=>entry.after?.includes("new-server.js")).length).toBeGreaterThanOrEqual(2);
});


it("persists state-only retirement after generated files were already removed",async()=>{
 const options=await fixture();await applyPlan(await compiler.plan({root:options.root}));
 const stateFile=path.join(options.root,".canonfig",".harness-state.json");
 const state=JSON.parse(await fs.readFile(stateFile,"utf8"));
 for(const file of Object.keys(state.artifacts))await fs.rm(path.join(options.root,file),{force:true});
 const config=path.join(options.root,".canonfig","harness.json");
 await fs.writeFile(config,(await fs.readFile(config,"utf8")).replaceAll('"enabled":true','"enabled":false'));
 const control=new AbortController();let polls=0;let writes=0;
 await watchHarness(options,()=>undefined,control.signal,{plan:input=>compiler.plan(input),apply:async plan=>{writes++;await applyPlan(plan);},pause:async()=>{if(++polls===6)control.abort();}});
 expect(writes).toBe(1);await expect(fs.stat(stateFile)).rejects.toMatchObject({code:"ENOENT"});
});
it("Effect interruption waits for an in-flight command to finish cleanup",async()=>{
 const started=Promise.withResolvers<void>();const cancelled=Promise.withResolvers<void>();const release=Promise.withResolvers<void>();let cleaned=false;
 const fiber=Effect.runFork(runCancellablePromise(async signal=>{
  signal.addEventListener("abort",()=>cancelled.resolve(),{once:true});started.resolve();
  await cancelled.promise;await release.promise;cleaned=true;
 }));
 await started.promise;const interruption=Effect.runPromise(Fiber.interrupt(fiber));
 await cancelled.promise;expect(cleaned).toBe(false);release.resolve();await interruption;expect(cleaned).toBe(true);
});
it.skipIf(process.platform==="win32").each(["SIGINT","SIGTERM"] as const)("the actual CLI releases its watch lock on %s",async signal=>{
 const options=await fixture();
 const child=spawn(process.execPath,["--import","tsx",path.resolve(import.meta.dirname,"../../src/runtime/main.ts"),"harness","watch","--root",options.root,"--json"],{
  env:{...process.env,HOME:options.root,USERPROFILE:options.root,CANONFIG_LOG_FILE:path.join(options.root,"command.log"),XDG_CACHE_HOME:path.join(options.root,"cache"),XDG_STATE_HOME:path.join(options.root,"state")},stdio:["ignore","pipe","pipe"]
 });
 let output="";let errors="";const ready=Promise.withResolvers<void>();
 const closed=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",code=>{resolve(code);if(!output.includes('"harness.watch"'))ready.reject(new Error(errors||"CLI exited before watch started"));});});
 child.stdout.on("data",chunk=>{output+=chunk.toString();if(output.includes('"harness.watch"'))ready.resolve();});child.stderr.on("data",chunk=>{errors+=chunk.toString();});
 const timeout=setTimeout(()=>{ready.reject(new Error("CLI watch startup timed out"));child.kill("SIGKILL");},15000);
 try{
  await ready.promise;expect(child.kill(signal)).toBe(true);expect(await closed).toBe(signal==="SIGINT"?130:143);
  await expect(fs.stat(path.join(options.root,".canonfig",".harness-watch.lock"))).rejects.toMatchObject({code:"ENOENT"});
  expect(await fs.readFile(path.join(options.root,"AGENTS.md"),"utf8")).toContain("First");
 }finally{clearTimeout(timeout);if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await closed;}
});


it("requires two fresh observations even when a create plan repeats after apply",async()=>{
 const options=await fixture();const control=new AbortController();const plan=await compiler.plan({root:options.root});let polls=0;let writes=0;
 await watchHarness(options,()=>undefined,control.signal,{plan:async()=>plan,apply:async()=>{writes++;},pause:async()=>{
  polls++;if(polls===3)expect(writes).toBe(1);if(polls===4)control.abort();
 }});
 expect(writes).toBe(2);
});
