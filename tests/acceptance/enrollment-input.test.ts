import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  EnrollmentInputError,
  isPrivateEnrollmentCommand,
  privateEnrollmentArguments,
  readEnrollmentInput,
} from "../../src/runtime/enrollment-input.ts";

const argv = ["follower", "enroll", "--stdin", "--name", "laptop", "--profile", "workstation"];

describe("private enrollment input", () => {
  it("recognizes only follower enrollment and keeps the original argv unchanged", () => {
    expect(isPrivateEnrollmentCommand(argv)).toBe(true);
    expect(isPrivateEnrollmentCommand(["source", "invite", "--stdin"])).toBe(false);
    expect(privateEnrollmentArguments(argv)).toEqual([
      "follower", "enroll", "--name", "laptop", "--profile", "workstation",
    ]);
    expect(argv[2]).toBe("--stdin");
  });

  it.each([
    ["follower", "enroll", "--stdin"],
    [...argv, "--stdin"],
    [...argv, "--unknown"],
    [...argv, "literal-invitation"],
    [...argv, "--name", "another"],
    ["follower", "enroll", "--stdin", "--name", "--profile", "workstation"],
  ].map((arguments_) => ({ arguments_ })))("rejects malformed non-secret options before reading stdin: $arguments_", ({ arguments_ }) => {
    expect(() => privateEnrollmentArguments(arguments_)).toThrow(EnrollmentInputError);
  });

  it("accepts a chunked invitation only when the writer closes stdin", async () => {
    const stream = new PassThrough();
    const original = Buffer.from("opaque_");
    const result = readEnrollmentInput(stream);
    stream.write(original);
    stream.end("invitation-123\r\n");
    expect(await result).toBe("opaque_invitation-123");
    expect(original.toString()).toBe("opaque_");
    for (const event of ["data", "end", "error", "close"]) {
      expect(stream.listenerCount(event)).toBe(0);
    }
  });

  it.each(["", "   ", "token second-token", "token\0", "token\nsecond"])(
    "rejects empty or multiple invitations without reflecting the value", async (value) => {
      const stream = new PassThrough();
      const result = readEnrollmentInput(stream);
      stream.end(value);
      await expect(result).rejects.toThrow("one nonempty base64url invitation");
    },
  );

  it("rejects malformed UTF-8 instead of repairing bytes", async () => {
    const stream = new PassThrough();
    const result = readEnrollmentInput(stream);
    stream.end(Buffer.from([0xc3, 0x28]));
    await expect(result).rejects.toThrow("not valid UTF-8");
  });

  it("enforces the byte bound while input is arriving", async () => {
    const stream = new PassThrough();
    const result = readEnrollmentInput(stream, { maximumBytes: 4 });
    stream.write("12345");
    await expect(result).rejects.toThrow("exceeds the 4 byte limit");
    stream.destroy();
  });

  it("times out a writer that never closes, even after receiving a token", async () => {
    const stream = new PassThrough();
    const result = readEnrollmentInput(stream, { timeoutMilliseconds: 20 });
    stream.write("opaque-token");
    await expect(result).rejects.toThrow("timed out waiting for EOF");
    stream.destroy();
  });

  it("settles early closure and does not report stream error contents", async () => {
    const closed = new PassThrough();
    const closedResult = readEnrollmentInput(closed);
    closed.destroy();
    await expect(closedResult).rejects.toThrow("closed before EOF");
    const errored = new PassThrough();
    const erroredResult = readEnrollmentInput(errored);
    errored.destroy(new Error("do-not-reflect-this-credential"));
    await expect(erroredResult).rejects.toThrow("Private enrollment input could not be read");
  });

  it("supports cancellation and rejects already-aborted input", async () => {
    const controller = new AbortController();
    const stream = new PassThrough();
    const result = readEnrollmentInput(stream, { signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow("interrupted");
    await expect(readEnrollmentInput(stream, { signal: controller.signal })).rejects.toThrow("interrupted");
    stream.destroy();
  });

  it("refuses interactive or object-mode input and invalid limits", async () => {
    const terminal = Object.assign(new PassThrough(), { isTTY: true });
    await expect(readEnrollmentInput(terminal)).rejects.toThrow("not an interactive terminal");
    await expect(readEnrollmentInput(new PassThrough({ objectMode: true }))).rejects.toThrow("byte stream");
    await expect(readEnrollmentInput(new PassThrough(), { maximumBytes: 0 })).rejects.toThrow("Invalid");
    await expect(readEnrollmentInput(new PassThrough(), { timeoutMilliseconds: 0 })).rejects.toThrow("Invalid");
  });
});

// Exercise the real entrypoint. Invalid invitation bytes must fail before the
// state layer is constructed, without contacting an enrollment endpoint.
it("the CLI consumes private stdin without reflecting it or creating state on invalid input", () => {
  const home = mkdtempSync(resolve(tmpdir(), "canonfig-private-input-"));
  const privateValue = Buffer.from("private-invalid-invitation").toString("base64url");
  try {
    const result = spawnSync(process.execPath, [
      "--import", "tsx", resolve(import.meta.dirname, "../../src/runtime/main.ts"), ...argv, "--json",
    ], {
      input: privateValue,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, HOME: home, USERPROFILE: home,
        CANONFIG_STATE_PATH: resolve(home, "state.sqlite") },
    });
    expect(result.status, result.stderr).toBe(2);
    expect(result.stdout + result.stderr).not.toContain(privateValue);
    expect(JSON.parse(result.stderr).message).toBe("Invalid enrollment invitation");
    expect(existsSync(resolve(home, "state.sqlite"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
