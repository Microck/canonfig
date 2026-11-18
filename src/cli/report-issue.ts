import { execFile, type ExecFileException } from "node:child_process";
import { addAbortSignal } from "node:stream";
import { debuglog } from "node:util";
import { Schema } from "effect";

import { GitHubAccount, issueRepository, issueTrackerUrl } from "../domain/issue-reporting.ts";
import {
  issueReportingPreferenceBusy, issueReportingPreferenceChanged, issueReportingPreferenceError, readIssueReportingPreference,
  readIssueReportingSnapshot, startApprovedIssueSubmission, writeIssueReportingPreference,
} from "../runtime/issue-reporting-preference.ts";
import { packageVersion } from "../runtime/build-identity.ts";
import { type IssueReportingPreferenceCommand, parseReportIssueArguments } from "../runtime/command-routing.ts";
import { RunLockHeldError } from "../synchronization/synchronization.errors.ts";
import { collectLiteralCredentialValues } from "../secrets/credential-policy.ts";
import type { CliIo } from "./cli.ts";
import { CliExitCode } from "./exit-codes.ts";
import { redactText } from "./redaction.ts";
import { type CliOutputFormat, type CliResult, renderCliResult } from "./render.ts";

const childProcessDebug = debuglog("child_process");
const standaloneGitHubToken = /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/gu;
const issueNumber = /^[1-9]\d*$/u;
const maximumInputBytes = 60 * 1024;
const maximumTitleLength = 256;
const maximumBodyLength = 65_536;
const unpairedSurrogate = /\p{Cs}/u;
const decodeAccount = Schema.decodeUnknownResult(Schema.fromJsonString(GitHubAccount));
const decodeDraft = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({
  title: Schema.String,
  body: Schema.String,
})), { onExcessProperty: "error" });

async function readDraft(input: NodeJS.ReadStream, signal: AbortSignal): Promise<{ title: string; body: string } | undefined> {
  if (input.isTTY) return undefined;
  const chunks: Buffer[] = [];
  let bytes = 0;
  // SAFETY: process.stdin has no text encoding set and supplies Buffer chunks.
  for await (const chunk of addAbortSignal(signal, input) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > maximumInputBytes) return undefined;
    chunks.push(chunk);
  }
  const draft = decodeDraft(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));

  const title = draft.title.trim();
  const body = draft.body;
  // Keep controls out of the terminal preview. Markdown accepts tabs, LF and CRLF.
  if (!title || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(title)
    || !body.trim() || /[^\P{Cc}\t\n\r]|\r(?!\n)/u.test(body)) {
    return undefined;
  }
  return { title, body };
}

function runGitHub(args: readonly string[], options: { signal: AbortSignal; body?: string; token?: string }): Promise<{ error: ExecFileException | null; stdout: string }> {
  if (options.signal.aborted) return Promise.resolve({ error: new Error("GitHub CLI operation interrupted"), stdout: "" });
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: "1", GH_DEBUG: "" };
  if (options.token !== undefined) env.GH_TOKEN = options.token;
  return new Promise((resolve) => {
    const child = execFile("gh", args, {
      env,
      maxBuffer: 64 * 1024,
      windowsHide: true,
      timeout: 30_000,
      // A wrapper can ignore SIGTERM. Keep cancellation and the deadline bounded.
      killSignal: "SIGKILL",
    }, (error, stdout) => resolve({ error, stdout }));
    // execFile's killSignal covers its deadline. Use the same signal on
    // cancellation and let the callback wait for the child's pipes to close.
    const abort = () => { child.kill("SIGKILL"); };
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("close", () => options.signal.removeEventListener("abort", abort));
    // If gh stops before consuming the body, its result explains the failure.
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.body);
  });
}

type AuthenticatedAccount =
  | { kind: "authenticated"; account: typeof GitHubAccount.Type; token: string }
  | { kind: "unavailable" | "signed-out" };

async function authenticatedAccount(signal: AbortSignal): Promise<AuthenticatedAccount> {
  // Use one credential for identification and submission, even if the active
  // gh account switches between those calls. Never store it or pass it as argv.
  const credentials = await runGitHub(["auth", "token", "--hostname", "github.com"], { signal });
  const token = credentials.stdout.trim();
  if (credentials.error?.code === "ENOENT") return { kind: "unavailable" };
  if (credentials.error || !token || signal.aborted) return { kind: "signed-out" };
  const identity = await runGitHub(["api", "--hostname", "github.com", "user", "--jq", "{id,login}"], { signal, token });
  if (identity.error?.code === "ENOENT") return { kind: "unavailable" };
  if (identity.error || signal.aborted) return { kind: "signed-out" };
  const account = decodeAccount(identity.stdout);
  return account._tag === "Success"
    ? { kind: "authenticated", account: account.success, token }
    : { kind: "signed-out" };
}

type ReportWriter = (result: Omit<CliResult, "command">, secrets?: ReadonlyArray<string>) => void;

const signIn = "Sign in to GitHub.com with 'gh auth login --hostname github.com', then retry.";
const missingGitHub = "Install the GitHub CLI before continuing.";
const consentRequired = "Automatic issue reporting requires consent on this machine for the current GitHub account.";

function writePreferenceFailure(cause: Error | undefined, signal: AbortSignal, write: ReportWriter): void {
  if (signal.aborted) return;
  if (cause instanceof RunLockHeldError) {
    write({ message: issueReportingPreferenceBusy, exitCode: CliExitCode.conflictOrDrift });
  } else {
    write({ message: issueReportingPreferenceError, exitCode: CliExitCode.usageOrConfiguration });
  }
}

async function changeReportingPreference(
  command: IssueReportingPreferenceCommand, signal: AbortSignal, write: ReportWriter,
): Promise<void> {
  try {
    let preference;
    if (command.kind === "status") {
      preference = await readIssueReportingPreference();
    } else if (command.kind === "disable") {
      preference = await writeIssueReportingPreference({ preference: { status: "disabled" } });
    } else {
      const identity = await authenticatedAccount(signal);
      if (signal.aborted) return;
      if (identity.kind !== "authenticated") {
        write({
          message: identity.kind === "unavailable" ? missingGitHub : signIn,
          exitCode: CliExitCode.humanActionRequired,
        });
        return;
      }
      const { account } = identity;
      if (command.kind !== "enable") {
        const { revision, preference: observed } = await readIssueReportingSnapshot();
        write({
          message: `GitHub CLI is signed in as @${account.login}. To enable automatic public issue reporting, run:\ncanonfig report-issue automatic enable --account ${account.id} --revision ${revision}`,
          data: { account, revision, status: observed.status },
          exitCode: CliExitCode.success,
        });
        return;
      }
      if (String(account.id) !== command.accountId) {
        write({
          message: "The active GitHub account changed. Check the account and ask for approval again.",
          exitCode: CliExitCode.humanActionRequired,
        });
        return;
      }
      preference = await writeIssueReportingPreference({
        preference: { status: "enabled", account },
        expectedRevision: command.revision,
      });
    }
    if (preference === undefined) {
      write({ message: issueReportingPreferenceChanged, exitCode: CliExitCode.conflictOrDrift });
      return;
    }
    const message = preference.status === "enabled"
      ? `Automatic public issue reporting is on for @${preference.account.login} on this machine.`
      : preference.status === "disabled"
      ? "Automatic issue reporting is off."
      : "Automatic issue reporting is off. Your agent can ask the first time it finds a bug.";
    write({ message, data: preference, exitCode: CliExitCode.success });
  } catch (cause) {
    writePreferenceFailure(cause instanceof Error ? cause : undefined, signal, write);
  }
}

async function submitAutomatically(
  args: readonly string[], body: string, signal: AbortSignal, write: ReportWriter,
): Promise<Awaited<ReturnType<typeof runGitHub>> | undefined> {
  let started;
  try {
    const { preference, revision } = await readIssueReportingSnapshot();
    if (signal.aborted) return undefined;
    if (preference.status !== "enabled") {
      write({ message: consentRequired, exitCode: CliExitCode.humanActionRequired });
      return undefined;
    }
    const identity = await authenticatedAccount(signal);
    if (signal.aborted) return undefined;
    if (identity.kind !== "authenticated" || identity.account.id !== preference.account.id) {
      write({
        message: identity.kind === "authenticated" ? consentRequired : identity.kind === "unavailable" ? missingGitHub : signIn,
        exitCode: CliExitCode.humanActionRequired,
      });
      return undefined;
    }
    started = await startApprovedIssueSubmission(revision, signal, () => runGitHub(args, { signal, token: identity.token, body }));
  } catch (cause) {
    writePreferenceFailure(cause instanceof Error ? cause : undefined, signal, write);
    return undefined;
  }
  if (started === undefined) {
    if (!signal.aborted) write({ message: consentRequired, exitCode: CliExitCode.humanActionRequired });
    return undefined;
  }
  return started.completion;
}

export async function runReportIssueCli(
  arguments_: ReadonlyArray<string>,
  io: CliIo,
  input: NodeJS.ReadStream,
  format: CliOutputFormat,
  signal: AbortSignal,
): Promise<void> {
  const write: ReportWriter = (result, secrets = []) => {
    const output = renderCliResult({ command: "report-issue", ...result }, format, secrets);
    if (result.exitCode === CliExitCode.success) io.writeStdout(output);
    else io.writeStderr(output);
    io.setExitCode(result.exitCode);
  };
  const command = parseReportIssueArguments(arguments_);
  if (command === undefined) {
    write({
      message: "Use canonfig report-issue --help for usage.",
      exitCode: CliExitCode.usageOrConfiguration,
    });
    return;
  }

  const action = command.kind;
  // Node can print the entire child environment, including credentials from gh.
  if (action !== "preview" && childProcessDebug.enabled) {
    write({ message: "Turn off NODE_DEBUG=child_process before using GitHub CLI or changing issue reporting.", exitCode: CliExitCode.usageOrConfiguration });
    return;
  }
  if (action === "status" || action === "account" || action === "enable" || action === "disable") {
    await changeReportingPreference(command, signal, write);
    return;
  }

  // Parser and stream errors can quote the input or contain local paths.
  const draft = await readDraft(input, signal).catch(() => undefined);
  if (signal.aborted) return;
  if (draft === undefined) {
    write({
      message: "Pipe a UTF-8 JSON report of at most 60 KiB into --stdin with a nonempty, single-line title and a nonempty Markdown body.",
      exitCode: CliExitCode.usageOrConfiguration,
    });
    return;
  }
  const message = `Draft for ${issueTrackerUrl}`;
  const secrets = [
    ...collectLiteralCredentialValues(draft.title),
    ...collectLiteralCredentialValues(draft.body),
    ...(draft.title.match(standaloneGitHubToken) ?? []),
    ...(draft.body.match(standaloneGitHubToken) ?? []),
  ];
  const body = `${draft.body}\n\n---\nCanonfig ${packageVersion} · ${process.platform} ${process.arch} · Node.js ${process.versions.node}`;
  const publicTitle = redactText(draft.title, secrets);
  const publicBody = redactText(body, secrets);
  // Check the final text. Redaction can expand it or split a Unicode pair
  // when an escaped credential in the report decodes to a lone surrogate.
  if (unpairedSurrogate.test(publicTitle) || unpairedSurrogate.test(publicBody)) {
    write({
      message: "The report contains malformed Unicode after redaction. Remove or replace the malformed text.",
      exitCode: CliExitCode.usageOrConfiguration,
    });
    return;
  }
  const tooLong = publicTitle.length > maximumTitleLength
    ? `title to ${maximumTitleLength} characters`
    : publicBody.length > maximumBodyLength
    ? `body to ${maximumBodyLength} characters, including the environment details`
    : undefined;
  if (tooLong !== undefined) {
    write({
      message: `Shorten the report ${tooLong} after redaction.`,
      exitCode: CliExitCode.usageOrConfiguration,
    });
    return;
  }
  // Give the JSON renderer the same raw input so it applies redaction once.
  if (action === "preview" && format === "json") {
    write({ message, data: { title: draft.title, body, repository: issueRepository }, exitCode: CliExitCode.success }, secrets);
    return;
  }

  if (action === "preview") {
    io.writeStdout(`${message}\n\n${publicTitle}\n\n${publicBody}\n`);
    return;
  }

  if (signal.aborted) return;
  const args = [
    "issue", "create", "--repo", `github.com/${issueRepository}`,
    `--title=${publicTitle}`, "--body-file", "-",
  ];
  const submission = action === "automatic"
    ? await submitAutomatically(args, publicBody, signal, write)
    : await runGitHub(args, { signal, body: publicBody });
  if (signal.aborted || submission === undefined) return;
  if (submission.error?.code === "ENOENT") {
    write({
      message: action === "automatic"
        ? "Automatic reporting stopped because the GitHub CLI is unavailable. Restore it before retrying."
        : `Install the GitHub CLI and run 'gh auth login --hostname github.com', or file the report at ${issueTrackerUrl}/new/choose.`,
      exitCode: CliExitCode.humanActionRequired,
    });
    return;
  }

  const url = submission.stdout.trim();
  if (submission.error !== null || !url.startsWith(`${issueTrackerUrl}/`) || !issueNumber.test(url.slice(issueTrackerUrl.length + 1))) {
    write({
      message: `GitHub CLI did not confirm submission. Check ${issueTrackerUrl} before retrying, and verify sign-in with 'gh auth status --hostname github.com'.`,
      exitCode: CliExitCode.verificationOrApplyFailure,
    });
    return;
  }
  write({ message: "Issue filed.", data: { url }, exitCode: CliExitCode.success });
}
