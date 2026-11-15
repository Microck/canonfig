// Run with: node --import tsx docs/research/304-fleet-update/verify-publisher.mjs
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyFleetRelease, downloadFleetRelease } from "../../../src/runtime/fleet-release.ts";
const directory = mkdtempSync(join(tmpdir(), "canonfig-publisher-proof-"));
const lines = ["$ node --import tsx docs/research/304-fleet-update/verify-publisher.mjs"];
try {
  const release = await verifyFleetRelease("7.1.9", join(directory, "trust-cache"));
  lines.push(`PASS official npm registry signature and Sigstore publisher policy: ${JSON.stringify(release)}`);
  const tarball = await downloadFleetRelease(release, directory);
  assert.equal(`sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`, release.integrity);
  lines.push("PASS official tarball SHA-512 binding");
  await assert.rejects(downloadFleetRelease({ ...release, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` }, directory), /tarball integrity mismatch/u);
  lines.push("PASS wrong tarball integrity refused before staging");
} finally {
  rmSync(directory, { recursive: true, force: true });
  lines.push("Temporary trust cache and package bytes removed.");
  writeFileSync(join(import.meta.dirname, "publisher-output.txt"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}
