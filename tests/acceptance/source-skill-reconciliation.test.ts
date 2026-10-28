import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconcileSourceSkills } from "../../src/profile/skill-reconciliation.ts";
import { parseReconciliationArguments, runReconciliationCli } from "../../src/profile/skill-reconciliation-cli.ts";
import { atomicWrite } from "../../src/harness-configuration/core/filesystem.ts";
import { decodeMachineProfileJsonc } from "../../src/domain/profile.ts";
import { isSourceSkillReconciliation, sourceSkillReconciliationArguments } from "../../src/runtime/command-routing.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive:true, force:true }))); });
const skillResource = (id: string) => ({ id, kind:"skill", target:`~/.agents/skills/${id}`, spec:{kind:"skill",name:id,files:[{path:"SKILL.md",source:`skills/${id}/SKILL.md`}]}, verify:{method:"digest"} });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),"canonfig-reconcile-")); roots.push(root);
  for (const name of ["one","two"]) { await fs.mkdir(path.join(root,"skills",name),{recursive:true}); await fs.writeFile(path.join(root,"skills",name,"SKILL.md"),`# ${name}`); }
  const file=path.join(root,"profile.jsonc");
  await fs.writeFile(file,"// preserve this comment\n"+JSON.stringify({id:"dev",version:2,name:"Development",groups:[],resources:[skillResource("one"),skillResource("two")]},null,2)+"\n");
  return {root,file};
}

describe("Source skill deletion reconciliation",()=>{
 it("previews without state writes, then reconciles a previously observed deletion",async()=>{
  const {root,file}=await fixture(); const original=await fs.readFile(file,"utf8");
  expect((await reconcileSourceSkills(file,false)).observed).toEqual(["one","two"]);
  await expect(fs.stat(file+".skills-observed.json")).rejects.toMatchObject({code:"ENOENT"});
  await reconcileSourceSkills(file,true); await fs.rm(path.join(root,"skills","one"),{recursive:true});
  const preview=await reconcileSourceSkills(file,false);expect(preview.removed).toEqual(["one"]);expect(await fs.readFile(file,"utf8")).toBe(original);
  const applied=await reconcileSourceSkills(file,true);expect(applied.removed).toEqual(["one"]);expect(applied.backup).toBeDefined();
  expect(await fs.readFile(applied.backup!,"utf8")).toBe(original);
  const next=await fs.readFile(file,"utf8");expect(next).toContain("preserve this comment");expect(decodeMachineProfileJsonc(next).resources.map(r=>r.id)).toEqual(["two"]);
  expect((await reconcileSourceSkills(file,true)).removed).toEqual([]);
  expect(await fs.readFile(path.join(root,"skills","two","SKILL.md"),"utf8")).toBe("# two");
 });
 it.each([{deleted:["one"]}, {deleted:["one", "two"]}])("removes IDs in original unsorted JSONC order: $deleted",async({deleted})=>{
  const {root,file}=await fixture();
  const extra={id:"middle",kind:"file",target:"~/unrelated.txt",spec:{kind:"file",content:"keep me"},verify:{method:"digest"}};
  const resources=[skillResource("two"),extra,skillResource("one")];
  const original="// keep authored order\n"+JSON.stringify({id:"dev",version:2,name:"Development",resources},null,2)+"\n";
  await fs.writeFile(file,original);await reconcileSourceSkills(file,true);
  for(const id of deleted)await fs.rm(path.join(root,"skills",id),{recursive:true});
  expect((await reconcileSourceSkills(file,false)).removed).toEqual(deleted);
  expect(await fs.readFile(file,"utf8")).toBe(original);
  await reconcileSourceSkills(file,true);
  const next=await fs.readFile(file,"utf8");expect(next).toContain("keep authored order");
  expect(JSON.parse(next.slice(next.indexOf("{"))).resources).toEqual(resources.filter(resource=>!deleted.includes(resource.id)));
 });
 it("accepts an authored profile with omitted resources in preview and apply",async()=>{
  const {file}=await fixture();const original='// empty profile\n{"id":"dev","name":"Development"}';
  await fs.writeFile(file,original);
  expect(await reconcileSourceSkills(file,false)).toMatchObject({removed:[],observed:[]});
  expect(await reconcileSourceSkills(file,true)).toMatchObject({removed:[],observed:[]});
  expect(await fs.readFile(file,"utf8")).toBe(original);
 });
 it("refuses an initially missing skill rather than turning a typo into deletion",async()=>{
  const {root,file}=await fixture();const before=await fs.readFile(file,"utf8");await fs.rm(path.join(root,"skills","one"),{recursive:true});
  await expect(reconcileSourceSkills(file,true)).rejects.toThrow("prior observation");expect(await fs.readFile(file,"utf8")).toBe(before);
 });
 it("refuses missing parents, partial deletion, changed declarations and malformed state",async()=>{
  for(const mode of ["parent","marker","changed","state"]){
   const {root,file}=await fixture();await reconcileSourceSkills(file,true);
   if(mode==="parent")await fs.rm(path.join(root,"skills"),{recursive:true});
   if(mode==="marker")await fs.rm(path.join(root,"skills","one","SKILL.md"));
   if(mode==="changed"){await fs.rm(path.join(root,"skills","one"),{recursive:true});const text=await fs.readFile(file,"utf8");await fs.writeFile(file,text.replace('"name": "one"','"name": "renamed"'));}
   if(mode==="state")await fs.writeFile(file+".skills-observed.json","bad");
   const before=await fs.readFile(file,"utf8");await expect(reconcileSourceSkills(file,true)).rejects.toThrow();expect(await fs.readFile(file,"utf8")).toBe(before);
  }
 });
 it("blocks deleting a dependency without silently rewriting dependents",async()=>{
  const {root,file}=await fixture();const profile=decodeMachineProfileJsonc(await fs.readFile(file,"utf8"));
  await fs.writeFile(file,JSON.stringify({...profile,resources:profile.resources.map(r=>r.id==="two"?{...r,dependsOn:["one"]}:r)}));
  await reconcileSourceSkills(file,true);await fs.rm(path.join(root,"skills","one"),{recursive:true});const before=await fs.readFile(file,"utf8");
  await expect(reconcileSourceSkills(file,true)).rejects.toThrow();expect(await fs.readFile(file,"utf8")).toBe(before);
 });
 it("skips inline resources and never guesses their source directories",async()=>{
  const {file}=await fixture();const profile=decodeMachineProfileJsonc(await fs.readFile(file,"utf8"));
  await fs.writeFile(file,JSON.stringify({...profile,resources:[{...skillResource("inline"),spec:{kind:"skill",name:"inline",files:[{path:"SKILL.md",content:"# inline"}]}}]}));
  expect((await reconcileSourceSkills(file,true)).skipped).toEqual(["inline"]);
 });
 it("refuses a held lock and symlinked profile",async()=>{
  const {file}=await fixture();await fs.writeFile(file+".skills-reconcile.lock","");await expect(reconcileSourceSkills(file,true)).rejects.toThrow("lock");await fs.unlink(file+".skills-reconcile.lock");
  const link=file+".link";try{await fs.symlink(file,link);}catch{ return; }
  await expect(reconcileSourceSkills(link,true)).rejects.toThrow("regular files");
 });
 it("retains a backup and reports partial state refresh failure safely",async()=>{
  const {root,file}=await fixture();await reconcileSourceSkills(file,true);await fs.rm(path.join(root,"skills","one"),{recursive:true});
  await expect(reconcileSourceSkills(file,true,{write:async(target,...rest)=>{if(target.endsWith(".skills-observed.json"))throw new Error("fixture");return atomicWrite(target,...rest);}})).rejects.toThrow("Profile was updated and backed up");
  expect(decodeMachineProfileJsonc(await fs.readFile(file,"utf8")).resources.map(r=>r.id)).toEqual(["two"]);
  expect((await reconcileSourceSkills(file,true)).removed).toEqual([]);
 });
 it("validates watcher opt-in and polling interval",async()=>{
  const {file}=await fixture();await reconcileSourceSkills(file,true);
  expect(()=>parseReconciliationArguments(["--profile-file",file,"--watch"])).toThrow("--apply");
  expect(()=>parseReconciliationArguments(["--profile-file",file,"--interval","3"])).toThrow("--watch");
  expect(()=>parseReconciliationArguments(["--profile-file",file,"--apply","--watch","--interval","0"])).toThrow("seconds");
 });
 it("dispatches without Source enrollment or publication, preserving global JSON flags",async()=>{
  const {file}=await fixture();const output:string[]=[];let code=-1;
  await runReconciliationCli(["--profile-file",file,"--apply","--json"],{writeStdout:t=>output.push(t),writeStderr:t=>output.push(t),setExitCode:c=>{code=c;}});
  expect(code).toBe(0);expect(output.join("")).toContain("source.reconcile-skills");
  expect(isSourceSkillReconciliation(["source","--json","reconcile-skills"])).toBe(true);
  expect(sourceSkillReconciliationArguments(["source","--json","reconcile-skills","--apply"])).toEqual(["--json","--apply"]);
 });
});

it("rechecks profile edits and reappearing skills before the commit",async()=>{
 for(const mode of ["profile","reappeared"]){
  const {root,file}=await fixture();await reconcileSourceSkills(file,true);await fs.rm(path.join(root,"skills","one"),{recursive:true});
  const before=await fs.readFile(file,"utf8");
  await expect(reconcileSourceSkills(file,true,{write:atomicWrite,beforeCommit:async()=>{
   if(mode==="profile")await fs.writeFile(file,before+"// concurrent edit\n");
   else await fs.mkdir(path.join(root,"skills","one"));
  }})).rejects.toThrow(mode==="profile"?"changed during":"reappeared");
  expect(decodeMachineProfileJsonc(await fs.readFile(file,"utf8")).resources).toHaveLength(2);
 }
});

it("watches an actual source deletion and stops cleanly after reconciliation",async()=>{
 const {root,file}=await fixture();const controller=new AbortController();let passes=0;let code=-1;
 await runReconciliationCli(["--profile-file",file,"--apply","--watch","--interval","1","--json"],{
  writeStdout:()=>{passes++;if(passes===1)rmSync(path.join(root,"skills","one"),{recursive:true});else controller.abort();},
  writeStderr:()=>{throw new Error("unexpected reconciliation failure");},setExitCode:c=>{code=c;}
 },controller.signal);
 expect(passes).toBe(2);expect(code).toBe(0);
 expect(decodeMachineProfileJsonc(await fs.readFile(file,"utf8")).resources.map(r=>r.id)).toEqual(["two"]);
});
