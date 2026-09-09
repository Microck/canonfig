import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
const patches = [
  {
    path: "src/runtime/main.ts",
    sha: "7c0aef33b5b5ca8ae3256df93b504ba659d47a04",
    replacements: [
      ['import { SecretTransferError } from "../secrets/secret-store.ts";', 'import { SecretTransferError } from "../secrets/secret-store.ts";\nimport { installerHelp, isInstallerCommand, runInstallerCli } from "./installer-cli.ts";'],
      ['} else if (\n  isPrivateEnrollmentCommand(arguments_)', '} else if (isInstallerCommand(arguments_)) {\n  NodeRuntime.runMain(\n    Effect.promise(() => import("./layers.ts")).pipe(\n      Effect.flatMap(({ runtimeLayer }) =>\n        runInstallerCli(arguments_.slice(1), nodeCliIo).pipe(Effect.provide(runtimeLayer()))\n      ),\n    ),\n  );\n} else if (\n  isPrivateEnrollmentCommand(arguments_)'],
      ['`${outcome.text}${extraHelp}\\n`', '`${outcome.text}${extraHelp}${outcome._tag === "Help" ? `\\nLocal installer bindings:\\n${installerHelp}\\n` : ""}\\n`']
    ]
  },
  {
    path: "src/synchronization/resource-executors.ts",
    sha: "a79ffb4d5cb680317cabd6e23b9cb910b077eb77",
    replacements: [
      ['import { relativePathAncestors } from "./resource-plans.ts";', 'import { relativePathAncestors } from "./resource-plans.ts";\nimport { resolveInstallerInvocation } from "./installer-bindings.ts";'],
      ['    const executableName = method === "apt"\n      ? "apt-get"\n      : method === "homebrew"\n      ? "brew"\n      : method;\n    const executable = yield* machine.findExecutable({ name: executableName });', '    const installer = yield* resolveInstallerInvocation(method);'],
      ['    const result = yield* machine.runProcess({\n      executable: executable.path,\n      arguments: arguments_,\n      timeoutMilliseconds: context.limits.processTimeoutMilliseconds,', '    const result = yield* machine.runProcess({\n      executable: installer.executable,\n      arguments: [...installer.arguments, ...arguments_],\n      timeoutMilliseconds: context.limits.processTimeoutMilliseconds,']
    ]
  }
];
for (const patch of patches) {
  const bytes = readFileSync(patch.path);
  const digest = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  if (digest !== patch.sha) throw new Error(`Refusing changed input: ${patch.path}`);
  let text = bytes.toString("utf8");
  for (const [before, after] of patch.replacements) {
    if (text.split(before).length !== 2) throw new Error(`Non-unique patch anchor: ${patch.path}`);
    text = text.replace(before, after);
  }
  writeFileSync(patch.path, text);
}
unlinkSync("tools/publish-installer-binding.mjs");
unlinkSync(".github/workflows/publish-installer-binding.yml");
