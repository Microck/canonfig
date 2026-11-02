import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { regular, assertPrivateDirectory } from "./coordination.ts";

const Settings = Schema.Struct({
  version: Schema.Literal(1), root: Schema.NonEmptyString, prefix: Schema.NonEmptyString,
  npmCli: Schema.NonEmptyString, node: Schema.NonEmptyString, line: Schema.NonEmptyString, state: Schema.NonEmptyString,
});
export function readSettings(directory: string) {
  assertPrivateDirectory(directory);
  const path=join(directory,"settings.json");regular(path);
  const info=lstatSync(path);
  if(process.getuid && (info.uid!==process.getuid()||(info.mode&0o022)!==0))throw new Error("Self-update settings must be user-owned and not writable by other users");
  if(lstatSync(path).size>16384)throw new Error("Self-update settings exceed 16 KiB");
  return Schema.decodeUnknownSync(Schema.fromJsonString(Settings),{onExcessProperty:"error"})(readFileSync(path,"utf8"));
}
