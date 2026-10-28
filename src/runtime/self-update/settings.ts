import { readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { regular } from "./coordination.ts";

const Settings = Schema.Struct({
  version: Schema.Literal(1), root: Schema.NonEmptyString, prefix: Schema.NonEmptyString,
  npmCli: Schema.NonEmptyString, node: Schema.NonEmptyString, line: Schema.NonEmptyString, state: Schema.NonEmptyString,
});
export function readSettings(directory: string) {
  const path=join(directory,"settings.json");regular(path);
  if(lstatSync(path).size>16384)throw new Error("Self-update settings exceed 16 KiB");
  return Schema.decodeUnknownSync(Schema.fromJsonString(Settings),{onExcessProperty:"error"})(readFileSync(path,"utf8"));
}
