import { Predicate } from "effect";
import { readSettings } from "./settings.ts";
import type { UpdateResult } from "./core.ts";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CliIo } from "../../cli/cli.ts";
import { acquireGate, readersActive, updateDirectory } from "./coordination.ts";
import { enable, installation, update } from "./core.ts";

export const selfUpdateHelp = `Usage: canonfig self-update <enable|disable|status|check|apply|auto> [options]

enable --apply --confirm-idle --npm-cli /absolute/path/to/npm/bin/npm-cli.js
  Stop all Canonfig processes and schedules before first opt-in. Only a user-private
  global npm prefix under your home is supported. No service is installed.
disable --apply: stop future updates (only when no coordinated commands are active).
status: print local opt-in settings and any interrupted update.
check: query the official npm registry for a newer stable patch in this minor line.
apply --apply: stage, verify and activate that patch only when idle.
auto --apply [--once] [--interval SECONDS]: foreground periodic updater (24h default).
  Busy installations defer. An unfinished sync blocks. Successful activation exits;
  restart under the new build, or use --once from an external scheduler.
Major/minor changes require a coordinated fleet upgrade. No forced takeover,
service restart, credential changes or removal of retained package backups.
--json emits structured results. Every write requires --apply.
`;
export function parseSelfUpdateArguments(args: readonly string[]) {
  const tokens=args.filter(a=>a!=="--json"&&a!=="--no-input");
  if(tokens.length===0||tokens.includes("--help")||tokens.includes("-h")||tokens[0]==="help")return {help:true,command:"help",apply:false,idle:false,once:false,npmCli:"",interval:86400};
  const command=tokens[0];if(!["enable","disable","status","check","apply","auto"].includes(command!))throw new Error("Unknown self-update command");
  let apply=false,idle=false,once=false,npmCli="",interval=86400,hasInterval=false;const seen=new Set<string>();
  for(let i=1;i<tokens.length;i++){
   const arg=tokens[i]!;if(seen.has(arg))throw new Error(`Repeated option: ${arg}`);seen.add(arg);
   if(arg==="--apply")apply=true;else if(arg==="--confirm-idle")idle=true;else if(arg==="--once")once=true;
   else if(arg==="--npm-cli"||arg==="--interval"){
    const v=tokens[++i];if(!v||v.startsWith("--"))throw new Error(`${arg} requires a value`);
    if(arg==="--npm-cli")npmCli=v;else {hasInterval=true;interval=Number(v);if(!/^\d+$/u.test(v)||!Number.isInteger(interval)||interval<60||interval>604800)throw new Error("Interval must be 60..604800 seconds");}
   }else throw new Error(`Unknown option: ${arg}`);
  }
  if((once||hasInterval)&&command!=="auto")throw new Error("--once/--interval require auto");
  if((idle||npmCli)&&command!=="enable")throw new Error("--confirm-idle/--npm-cli require enable");
  if(apply&&(command==="check"||command==="status"))throw new Error("Read-only command does not accept --apply");
  if(command==="enable"&&!npmCli)throw new Error("enable requires --npm-cli");
 return {help:false,command,apply,idle,once,npmCli,interval};
}
export async function runSelfUpdateCli(args: readonly string[],root:string,io:CliIo,signal?:AbortSignal):Promise<void>{
 const json=args.includes("--json");
 type Status = {enabled:boolean;pending:boolean;settings:ReturnType<typeof readSettings>|null};
 const output=(data:string|UpdateResult|Status)=>io.writeStdout(json?`${JSON.stringify(data)}\n`:`${Predicate.isString(data)?data:JSON.stringify(data,null,2)}\n`);
 try{
  const {help,command,apply,idle,once,npmCli,interval}=parseSelfUpdateArguments(args);
  if(help){output(selfUpdateHelp);return;}
  const directory=updateDirectory(root);
  if(command==="status"){
   output({enabled:existsSync(join(directory,"settings.json")),pending:existsSync(join(directory,"pending.json")),settings:existsSync(join(directory,"settings.json"))?readSettings(directory):null});return;
  }
  if(command==="enable"){
   installation(root);if(!npmCli)throw new Error("enable requires --npm-cli");
   if(!apply){output("Preview: opt in to stable patch updates only. Stop all current Canonfig processes/schedules, then rerun with --apply --confirm-idle.");return;}
   await enable(root,npmCli,idle,undefined,undefined,signal);output("Self-update enabled. Run self-update auto --apply in foreground or schedule self-update auto --apply --once. Restart prior services only after enabling.");return;
  }
  if(command==="disable"){
   if(!apply){output("Preview: disable future self-updates. Rerun with --apply.");return;}
   const release=acquireGate(directory);try{
    if(existsSync(join(directory,"pending.json"))||readersActive(directory))throw new Error("Cannot disable while commands or an interrupted transaction exist");
    rmSync(join(directory,"settings.json"));
   }finally{release();}output("Self-updating disabled. Backups and receipts retained.");return;
  }
  // Checks require explicit opt-in so the npm executable/prefix are established.
  do {
   if(signal?.aborted)return;
   const result=await update(root,apply,undefined,signal);output(result);
   if(command!=="auto"||once||!apply||result.status==="updated")return;
   await delay(interval*1000,undefined,{signal});
  }while(!signal?.aborted);
 }catch(error){if(signal?.aborted)return;const message=error instanceof Error?error.message:String(error);io.writeStderr(json?`${JSON.stringify({error:message})}\n`:`${message}\n`);io.setExitCode(2);}
}
