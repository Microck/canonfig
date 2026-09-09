import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { exitCodeForFailure } from "../src/cli/exit-codes.ts";
import {
  classifiedErrorTags,
  describeRuntimeError,
} from "../src/cli/failure-taxonomy.ts";
import { SourceNotInitializedError } from "../src/enrollment/enrollment.errors.ts";
import {
  MachineFilesystemError,
  ProcessTimeoutError,
} from "../src/machine/machine-state.errors.ts";

// fileURLToPath rather than URL.pathname: pathname keeps the leading slash on
// a Windows drive path and leaves percent-encoded characters encoded, either of
// which readdir would reject.
const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

const typescriptFiles = async (
  directory: string,
): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const found: Array<string> = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await typescriptFiles(path));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
};

/**
 * Every tagged error declared anywhere in the source tree, by tag. The CLI
 * classifies failures from this tag alone, so an error type that is missing
 * from the taxonomy would fall through to exit 1 with a generic message.
 */
const declaredErrorTags = async (): Promise<ReadonlySet<string>> => {
  const tags = new Set<string>();
  for (const path of await typescriptFiles(sourceRoot)) {
    const source = await readFile(path, "utf8");
    for (
      const match of source.matchAll(
        /extends\s+(?:Schema\.|Data\.)?TaggedError<\w+>\(\)\(\s*"(?<tag>\w+)"/gu,
      )
    ) {
      const tag = match.groups?.tag;
      // CliCommandFailure is the terminal failure the taxonomy produces, not a
      // leaf error it classifies.
      if (tag !== undefined && tag !== "CliCommandFailure") tags.add(tag);
    }
  }
  return tags;
};

describe("CLI failure taxonomy", () => {
  it("classifies every tagged error declared in the source tree", async () => {
    const declared = await declaredErrorTags();
    const classified = classifiedErrorTags();
    const missing = [...declared].filter((tag) => !classified.has(tag)).sort();
    expect(missing).toEqual([]);
  });

  it("classifies no error type that no longer exists", async () => {
    const declared = await declaredErrorTags();
    const stale = [...classifiedErrorTags()]
      .filter((tag) => !declared.has(tag))
      .sort();
    expect(stale).toEqual([]);
  });

  it("never renders an error as its type name", () => {
    for (const tag of classifiedErrorTags()) {
      // An error carrying none of its declared fields is the worst case the
      // renderer has to survive; it must still not emit the bare tag.
      const described = describeRuntimeError(Object.assign(new Error(""), { _tag: tag }));
      expect(described.message).not.toBe(tag);
      expect(described.message.length).toBeGreaterThan(0);
    }
  });

  it("renders declared fields rather than the type name", () => {
    expect(
      describeRuntimeError(
        Object.assign(new Error(""), { _tag: "RevisionNotFoundError", revision: "rev-7" }),
      ).message,
    ).toBe("no published profile revision rev-7");
    expect(
      describeRuntimeError(
        Object.assign(new Error(""), { _tag: "ExecutableNotFoundError", name: "canonfig" }),
      ).message,
    ).toBe("canonfig was not found on PATH");
    expect(
      describeRuntimeError(
        Object.assign(new Error(""), {
          _tag: "ProcessTimeoutError",
          executable: "npm",
          timeoutMilliseconds: 600_000,
        }),
      ).message,
    ).toBe("npm did not finish within 600000 ms");
    expect(
      describeRuntimeError(
        Object.assign(new Error(""), {
          _tag: "PlannerVerificationKindMismatchError",
          resource: "link",
          kind: "file",
          method: "digest",
        }),
      ).message,
    ).toBe("resource link (file) cannot be verified by digest");
  });

  it("prefers an error's own message over the fallback rendering", () => {
    expect(
      describeRuntimeError(
        Object.assign(new Error(""), {
          _tag: "MachineFilesystemError",
          operation: "open",
          path: "/tmp/x",
          message: "ENOENT: no such file or directory",
        }),
      ).message,
    ).toBe("ENOENT: no such file or directory");
  });

  it("treats an unclassified error as internal", () => {
    const described = describeRuntimeError(
      Object.assign(new Error(""), { _tag: "SomeBrandNewError" }),
    );
    expect(described.category).toBe("internal");
    expect(exitCodeForFailure(described.category)).toBe(1);
  });

  it("reserves exit 1 for defects, so deliberate refusals classify elsewhere", () => {
    // Each of these was previously misfiled as an internal error because the
    // type name matched none of the categorizer's words.
    for (
      const tag of [
        "DuplicateFollowerIdentityError",
        "DiscoveryFilesystemError",
        "UnresolvedPublicationProposalError",
        "PublicationSigningError",
        "RecoveryIntegrityError",
      ]
    ) {
      const described = describeRuntimeError(Object.assign(new Error(""), { _tag: tag }));
      expect(exitCodeForFailure(described.category)).not.toBe(1);
    }
  });
});

describe("tagged error rendering", () => {
  it("declares every tagged error through the shared factory", async () => {
    // The factory is the one place that gives every error a printable message
    // and Node's native inspection. A class built on `Schema.TaggedError`
    // directly would silently lose both.
    const direct: Array<string> = [];
    for (const path of await typescriptFiles(sourceRoot)) {
      if (path.endsWith(join("domain", "tagged-error.ts"))) continue;
      if (/Schema\.TaggedError</u.test(await readFile(path, "utf8"))) direct.push(path);
    }
    expect(direct).toEqual([]);
  });

  it("renders the declared fields as the message when a class declares none", () => {
    const error = new ProcessTimeoutError({
      executable: "powershell.exe",
      timeoutMilliseconds: 10_000,
    });
    const header = 'ProcessTimeoutError: executable="powershell.exe" timeoutMilliseconds=10000';
    expect(String(error)).toBe(header);
    expect(error.stack?.split("\n")[0]).toBe(header);
    // Node's native error rendering: header, stack frames, then the fields.
    expect(inspect(error)).toContain(header);
    expect(inspect(error)).toContain("\n    at ");
    expect(inspect(error)).toContain("timeoutMilliseconds: 10000");
  });

  it("keeps a declared message verbatim", () => {
    const error = new MachineFilesystemError({
      operation: "mutate managed path",
      path: "/managed/settings.json",
      message: "EACCES: permission denied",
    });
    expect(error.message).toBe("EACCES: permission denied");
    expect(String(error)).toBe("MachineFilesystemError: EACCES: permission denied");
    expect(inspect(error)).toContain("MachineFilesystemError: EACCES: permission denied");
  });

  it("leaves tag matching and the encoded fields unchanged", async () => {
    const error = new ProcessTimeoutError({ executable: "pwsh", timeoutMilliseconds: 1 });
    const encoded = { _tag: "ProcessTimeoutError", executable: "pwsh", timeoutMilliseconds: 1 };
    const caught = await Effect.runPromise(
      Effect.fail(error).pipe(
        Effect.catchTag("ProcessTimeoutError", (timeout) => Effect.succeed(timeout.executable)),
      ),
    );
    expect(caught).toBe("pwsh");
    expect(Schema.encodeSync(ProcessTimeoutError)(error)).toEqual(encoded);
    expect(JSON.parse(JSON.stringify(error))).toEqual(encoded);
    expect(Schema.decodeUnknownSync(ProcessTimeoutError)(encoded).message).toBe(
      'executable="pwsh" timeoutMilliseconds=1',
    );
  });

  it("keeps the taxonomy wording for a class that declares no message", () => {
    // The synthetic message must not displace the operator guidance the
    // taxonomy builds from `operation` for this error.
    const described = describeRuntimeError(
      new SourceNotInitializedError({ operation: "publish" }),
    );
    expect(described.message).toBe(
      "publish needs an initialized Source Machine; run 'canonfig source init' first",
    );
  });
});
