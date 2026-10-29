// First-run flow for a simulated, unconfigured machine.
// `onDone` returns the setup choices that seed the new workspace role.
import { useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Check, Circle, FileArrowUp, RadioButton } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { DitherShader } from "@/lib/dither";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { machine, profile } from "@/shared/data";
import { DitherProgress, Hint, Mono, Term, goldButton } from "@/shared/shared";
import { shq } from "@/shared/shell";
import { CliEquivalent, DisclosureTrigger, Facts, Field, FieldError, OnboardingShell, RadioRow, Stepper, simulate, useFocusOnMount } from "./kit";

// Rings drifting inward toward the centre: many machines converging on one.
// At speed 1 a ring takes about 20 seconds to move one ring inward.
const CONVERGE_FIELD = /* glsl */ `
float field(vec2 uv, vec2 res, float t) {
  vec2 p = (uv - vec2(0.5, 0.48)) * vec2(res.x / res.y, 1.0);
  float r = length(p);
  float wobble = (fbm(p * 1.3 + vec2(t * 0.02, -t * 0.015)) - 0.5) * 0.16;
  float band = abs(fract((r + wobble) * 5.0 + t * 0.05) - 0.5) * 2.0;
  float ring = smoothstep(0.78, 1.0, band);
  float halo = smoothstep(0.34, 0.95, r);
  return clamp(ring * halo * 0.7 + halo * 0.05, 0.0, 1.0);
}
`;

type Stage = "choose" | "source" | "follower";

/** A new Source, as the wizard created it. */
export interface SourceSetup {
  role: "source";
  profileName: string;
  profileFile: string;
  /** "manual" installs no background service: atlas serves only while `canonfig source serve` runs. */
  service: "service" | "manual";
  port: number;
  /** Whether `source scan` proposed tools. Without it the new Source starts with an empty profile. */
  scan: boolean;
}

/** A follower that just joined: enrolled, revision downloaded, nothing applied yet. */
export interface FollowerSetup {
  role: "follower";
  name: string;
  profileId: string;
  tunnel: boolean;
  /** Whether the profile's default schedule was set. False leaves the machine without a schedule. */
  schedule: boolean;
}

export type Setup = SourceSetup | FollowerSetup;

const DEFAULT_PORT = 17342;

export function Onboarding({ onDone }: { onDone: (setup: Setup) => void }) {
  const [stage, setStage] = useState<Stage>("choose");

  return (
    <OnboardingShell hostname={machine.hostname}>
      <div className={cn("relative isolate flex min-h-full flex-col items-center overflow-hidden px-6 py-16", stage === "choose" ? "justify-center" : "justify-start pt-[12vh]")}>
        {/* Drifts calmly behind the first question, then holds its frame behind
            the wizard, where people read a form slowly. Still under reduced motion. */}
        <div aria-hidden className="absolute inset-0 -z-10">
          <DitherShader
            field={CONVERGE_FIELD}
            palette={["--dither-paper", "--dither-color-grey", "--dither-color-green"]}
            cell={3}
            animate={stage === "choose"}
            fps={15}
            stillTime={6}
            className="absolute inset-0 opacity-60"
          />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_48%_52%_at_50%_48%,var(--background)_45%,transparent_100%)]" />
        </div>
        {stage === "choose" && <Choose onPick={setStage} />}
        {stage === "source" && <SourceWizard onBack={() => setStage("choose")} onDone={onDone} />}
        {stage === "follower" && <FollowerWizard onBack={() => setStage("choose")} onDone={onDone} />}
      </div>
    </OnboardingShell>
  );
}

function Choose({ onPick }: { onPick: (stage: Stage) => void }) {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div className="w-full max-w-[680px] pb-10 text-center">
      <h1 ref={heading} tabIndex={-1} className="text-[28px] leading-tight font-semibold tracking-[-0.025em] outline-none">
        What should this machine do?
      </h1>
      <p className="mx-auto mt-3 max-w-[480px] leading-relaxed text-balance text-muted-foreground">
        Canonfig keeps your AI agent instructions, settings, skills and tools the same on every machine.
      </p>
      <div className="mt-9 grid grid-cols-2 gap-3 text-left">
        <Choice
          title="Make this the Source"
          description="For the machine where you edit your setup. Other machines copy from it, and only this one publishes changes."
          facts={[
            <>
              Creates <Mono>{machine.profileFile}</Mono>
            </>,
            "Runs a small service other machines connect to",
          ]}
          onClick={() => onPick("source")}
        />
        <Choice
          title="Copy the setup from another machine"
          description="For a machine that should get its setup from your Source."
          facts={["Needs an invitation file from the Source", "Gets updates on a schedule you choose", "Settings you mark as local stay as they are"]}
          onClick={() => onPick("follower")}
        />
      </div>
      <p className="mt-6 text-sm text-muted-foreground">Not sure? Make the computer you use most the Source.</p>
    </div>
  );
}

function Choice({ title, description, facts, onClick }: { title: string; description: string; facts: ReactNode[]; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group flex flex-col rounded-xl border border-border bg-panel p-5 text-left hover:border-border-strong hover:bg-raised">
      <span className="flex items-center justify-between gap-3 text-[15px] font-medium">
        {title}
        <ArrowRight aria-hidden className="size-4 shrink-0 text-faint group-hover:text-foreground" />
      </span>
      <span className="mt-1.5 leading-relaxed text-muted-foreground">{description}</span>
      <span className="mt-4 block space-y-1.5 border-t border-border pt-4 text-sm text-muted-foreground">
        {facts.map((fact, i) => (
          <span key={i} className="block">
            {fact}
          </span>
        ))}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Wizard frame                                                        */
/* ------------------------------------------------------------------ */

/**
 * One form for every step, so Enter continues from any field. A step that is
 * not complete keeps Continue enabled: submitting it calls `onBlocked`, and the
 * step then shows its errors next to the fields that need attention.
 */
function Wizard({
  title,
  steps,
  step,
  onStep,
  onBack,
  finalLabel,
  busyLabel,
  onFinish,
  blocked = false,
  onBlocked,
  busy = false,
  done,
  cli,
  children,
}: {
  title: string;
  steps: string[];
  step: number;
  onStep: (s: number) => void;
  onBack: () => void;
  finalLabel: string;
  busyLabel: string;
  onFinish: () => void;
  blocked?: boolean;
  onBlocked?: () => void;
  busy?: boolean;
  done?: ReactNode;
  cli: string[];
  children: ReactNode;
}) {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const last = step === steps.length - 1;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy || done) return;
    if (blocked) onBlocked?.();
    else if (last) onFinish();
    else onStep(step + 1);
  };

  return (
    <div className="w-full max-w-[600px] pb-12">
      {/* Kept in layout (invisible, so not focusable) once done, so the card doesn't jump. */}
      <button
        type="button"
        onClick={onBack}
        disabled={busy}
        className={cn("mb-4 inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground hover:text-foreground disabled:text-faint", done && "invisible")}
      >
        <ArrowLeft className="size-3.5" /> Change my answer
      </button>
      <form noValidate onSubmit={submit} className="rounded-xl border border-border bg-panel">
        {!done && (
          <div className="border-b border-border px-6 pt-5 pb-4">
            <h1 ref={heading} tabIndex={-1} className="text-[15px] font-medium outline-none">
              {title}
            </h1>
            <Stepper steps={steps} step={step} />
          </div>
        )}
        <div className="px-6 py-6">
          {done ?? (
            <>
              <h2 className="sr-only">{steps[step]}</h2>
              {children}
              <CliEquivalent lines={cli} className="mt-7" />
            </>
          )}
        </div>
        {!done && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
            {step > 0 && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => onStep(step - 1)}>
                Back
              </Button>
            )}
            {last ? (
              <Button type="submit" className={goldButton} disabled={busy}>
                {/* Both labels share one grid cell so the button keeps its width when it switches. */}
                <span className="grid">
                  <span className={cn("col-start-1 row-start-1", busy && "invisible")}>{finalLabel}</span>
                  <span className={cn("col-start-1 row-start-1", !busy && "invisible")}>{busyLabel}</span>
                </span>
              </Button>
            ) : (
              <Button type="submit" variant="secondary" className="min-w-24">
                Continue
              </Button>
            )}
          </div>
        )}
      </form>
    </div>
  );
}

/**
 * The live checklist while a fake job runs. Icons are static: no spinner.
 * Screen readers hear a count, not a second copy of the current line.
 */
function RunList({ items, progress }: { items: string[]; progress: number }) {
  const at = (progress / 100) * items.length;
  const finished = Math.min(items.length, Math.floor(at));
  return (
    <>
      <ul className="mt-4 space-y-2">
        {items.map((label, i) => {
          const state = at >= i + 1 ? "done" : at > i ? "running" : "waiting";
          return (
            <li key={label} className="flex items-center gap-2.5">
              <span className="grid size-4 place-items-center">
                {state === "done" ? (
                  <Check weight="bold" className="size-3.5 text-ok" />
                ) : state === "running" ? (
                  <RadioButton weight="fill" className="size-3.5 text-foreground" />
                ) : (
                  <Circle className="size-3 text-faint" />
                )}
              </span>
              <span className={cn("transition-colors duration-150 ease-snap", state === "waiting" && "text-muted-foreground")}>{label}</span>
            </li>
          );
        })}
      </ul>
      <p role="status" className="sr-only">
        {finished === items.length ? "All done" : `${finished} of ${items.length} done`}
      </p>
    </>
  );
}

function Finished({ title, children, next, action, onOpen }: { title: string; children: ReactNode; next: ReactNode; action: string; onOpen: () => void }) {
  const heading = useFocusOnMount<HTMLHeadingElement>();
  return (
    <div>
      <span aria-hidden className="grid size-8 place-items-center rounded-full bg-ok/15 text-ok">
        <Check weight="bold" className="size-4" />
      </span>
      <h2 ref={heading} tabIndex={-1} className="mt-4 text-[17px] font-medium tracking-[-0.01em] outline-none">
        {title}
      </h2>
      <div className="mt-2 leading-relaxed text-muted-foreground">{children}</div>
      <div className="mt-6 flex items-center justify-between gap-6 border-t border-border pt-4">
        <p className="text-muted-foreground">{next}</p>
        <Button type="button" className={cn(goldButton, "shrink-0")} onClick={onOpen}>
          {action}
          <ArrowRight data-icon="inline-end" />
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Source init                                                         */
/* ------------------------------------------------------------------ */

function SourceWizard({ onBack, onDone }: { onBack: () => void; onDone: (setup: SourceSetup) => void }) {
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState(false);
  const [name, setName] = useState(profile.name);
  const [file, setFile] = useState(machine.profileFile);
  const [scan, setScan] = useState(true);
  const [service, setService] = useState<"service" | "manual">("service");
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [advanced, setAdvanced] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [done, setDone] = useState(false);

  // Validated as typed, never rewritten: stripping characters would turn "1.5" into a different port.
  const portNumber = Number(port);
  const portValid = /^\d+$/.test(port) && portNumber >= 1 && portNumber <= 65535;
  const creates = [
    `Profile file at ${file}`,
    "Canonfig's own records at ~/.canonfig/state.sqlite",
    "A signing key, kept in your login keyring",
    ...(service === "service" ? [`Background service at https://127.0.0.1:${portNumber}`] : []),
    ...(scan ? ["2 proposed tools, found in ~/.claude.json and ~/.codex/config.toml"] : []),
  ];
  // Never show a port the CLI would reject; the placeholder marks what's missing.
  const portFlag = !portValid ? " --port <port>" : portNumber === DEFAULT_PORT ? "" : ` --port ${portNumber}`;

  const nameError = tried && !name.trim() ? "Enter a profile name." : null;
  const fileError = tried && !file.trim() ? "Enter where to save the profile file." : null;
  const portError = tried && !portValid ? "Enter a whole number from 1 to 65535." : null;

  return (
    <Wizard
      title="Make atlas the Source"
      steps={["Your profile", "The service", "Create"]}
      step={step}
      onStep={(s) => {
        setTried(false);
        setStep(s);
      }}
      onBack={onBack}
      finalLabel="Make atlas the Source"
      busyLabel="Creating…"
      blocked={(step === 0 && (!name.trim() || !file.trim())) || (step === 1 && !portValid)}
      onBlocked={() => {
        setTried(true);
        // The port lives under Advanced; its error must be visible.
        if (step === 1) setAdvanced(true);
      }}
      busy={progress !== null && !done}
      onFinish={() => {
        setProgress(0);
        simulate(2600, setProgress, () => setDone(true));
      }}
      cli={[
        "canonfig source init",
        // `source init` takes no profile options: the profile is a file the person authors, and later commands
        // read it by path. So the entered name and file appear as a note, quoted the same way as real arguments.
        `# The profile ${arg(name, "<name>")} lives in ${arg(file, "<profile.jsonc>")}; source digest and source publish read it with --profile-file ${arg(file, "<profile.jsonc>")}`,
        ...(scan ? ["canonfig source scan --file ~/.claude.json --file ~/.codex/config.toml"] : []),
        service === "service" ? `canonfig source service install${portFlag}` : `canonfig source serve${portFlag}`,
      ]}
      done={
        done ? (
          <Finished
            title="atlas is now the Source"
            action={scan ? "Review proposed tools" : "Open Canonfig"}
            onOpen={() => onDone({ role: "source", profileName: name.trim(), profileFile: file.trim(), service, port: portNumber, scan })}
            next={
              scan ? (
                <>
                  Next: check the 2 tools Canonfig found, then publish your first <Term term="Profile Revision" />.
                </>
              ) : (
                <>
                  Next: add what your other machines need, then publish your first <Term term="Profile Revision" />.
                </>
              )
            }
          >
            Your <Term term="Machine Profile" /> is <Mono className="text-foreground">{file.trim()}</Mono> in this demo workspace. The demo doesn't create or read that file; edit the profile
            here.
          </Finished>
        ) : undefined
      }
    >
      {step === 0 && (
        <div className="space-y-5">
          <p className="leading-relaxed text-muted-foreground">
            Your <Term term="Machine Profile" /> is one file that lists everything your other machines should have.
          </p>
          <div className="grid grid-cols-[1fr_1.4fr] gap-4">
            <Field label="Profile name" htmlFor="ob-name" error={nameError}>
              <Input id="ob-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} aria-describedby={nameError ? "ob-name-error" : undefined} />
            </Field>
            <Field label="Profile file" htmlFor="ob-file" hint="Canonfig keeps your comments when it edits this file." error={fileError}>
              <Input
                id="ob-file"
                value={file}
                onChange={(e) => setFile(e.target.value)}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={!!fileError}
                aria-describedby={fileError ? "ob-file-error" : undefined}
                className="font-mono text-[12px]"
              />
            </Field>
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50">
            <Checkbox checked={scan} onCheckedChange={(c) => setScan(c === true)} className="mt-px" />
            <span>
              <span className="font-medium">Suggest tools from my AI agent settings</span>
              <span className="mt-1 block text-sm text-muted-foreground">
                Reads only ~/.claude.json and ~/.codex/config.toml, and suggests a tool for each program they start, such as an MCP server. Nothing is added until you review it.
              </span>
            </span>
          </label>
        </div>
      )}
      {step === 1 && (
        <div className="space-y-5">
          <p className="leading-relaxed text-muted-foreground">
            Other machines connect to a small service on atlas. It only accepts connections from atlas itself, so they reach it over SSH, which each machine sets up when it joins.
          </p>
          <RadioGroup value={service} onValueChange={(v) => setService(v as "service" | "manual")} className="gap-2">
            <RadioRow value="service" title="Run it in the background" description="Starts when you log in and runs without a terminal open, so other machines can sync whenever you're logged in." />
            <RadioRow
              value="manual"
              title="Only when I start it"
              description={
                <>
                  Other machines can sync only while <Mono>canonfig source serve</Mono> runs in a terminal.
                </>
              }
            />
          </RadioGroup>
          <Collapsible open={advanced} onOpenChange={setAdvanced}>
            <DisclosureTrigger>Advanced</DisclosureTrigger>
            <CollapsibleContent className="mt-3 grid grid-cols-[auto_1fr] items-end gap-6">
              <Field label="Port" htmlFor="ob-port" error={portError}>
                <Input
                  id="ob-port"
                  inputMode="numeric"
                  autoComplete="off"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  aria-invalid={!!portError}
                  aria-describedby={portError ? "ob-port-error" : undefined}
                  className="w-28 font-mono text-[12px] tabular-nums"
                />
              </Field>
              {service === "service" && (
                <p className="pb-1.5 text-sm text-muted-foreground">
                  To keep the service running after you log out, run <Mono>loginctl enable-linger $USER</Mono>. Canonfig doesn't change this for you.
                </p>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}
      {step === 2 && (
        <div>
          {progress === null ? (
            <>
              <p className="mb-3 leading-relaxed text-muted-foreground">Canonfig creates these on atlas:</p>
              <ul className="space-y-2">
                {creates.map((c) => (
                  <li key={c} className="flex items-center gap-2.5">
                    <Circle className="size-3 text-faint" />
                    {c}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <DitherProgress value={progress} running={!done} label="Creating the Source" />
              <RunList items={creates} progress={progress} />
            </>
          )}
          {/* Stays put while creating, so nothing on the card swaps places. */}
          <p className="mt-5 text-sm text-muted-foreground">
            Other machines get nothing until you publish a <Term term="Profile Revision" />.
          </p>
        </div>
      )}
    </Wizard>
  );
}

/* ------------------------------------------------------------------ */
/* Follower enroll                                                     */
/* ------------------------------------------------------------------ */

/** A typed value as one shell argument, or a placeholder while the field is empty, so no line passes an empty argument. */
function arg(value: string, placeholder: string) {
  return value.trim() ? shq(value.trim()) : placeholder;
}

function FollowerWizard({ onBack, onDone }: { onBack: () => void; onDone: (setup: FollowerSetup) => void }) {
  const [step, setStep] = useState(0);
  const [tried, setTried] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);
  const [paste, setPaste] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasteTried, setPasteTried] = useState(false);
  const [tunnel, setTunnel] = useState(true);
  const [sshHost, setSshHost] = useState("atlas.local");
  const [sshUser, setSshUser] = useState("marcos");
  const [hostKey, setHostKey] = useState("./source-host-key.pub");
  const [advanced, setAdvanced] = useState(false);
  const [trusted, setTrusted] = useState(false);
  const [name, setName] = useState("laptop");
  const [profileId, setProfileId] = useState(profile.id);
  const [useSchedule, setUseSchedule] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [done, setDone] = useState(false);

  const steps = [
    ...(tunnel ? ["Opening the SSH tunnel to atlas"] : []),
    "Checking atlas's certificate",
    "Registering this machine with atlas",
    "Downloading revision 7",
    ...(useSchedule ? ["Setting the daily 09:00 schedule"] : []),
  ];

  // Typing keeps only lowercase letters, digits and dashes (spaces become dashes); edge dashes are trimmed
  // here rather than per keystroke, so typing "my laptop" can pass through "my-". Everything below uses this.
  const machineName = name.replace(/^-+|-+$/g, "");

  // Validate late: these only show after a Continue that couldn't proceed.
  const errors = {
    invite: step === 0 && invite === null ? "Use the example file, or paste the invitation." : null,
    host: step === 1 && tunnel && !sshHost.trim() ? "Enter the SSH host for atlas." : null,
    user: step === 1 && tunnel && !sshUser.trim() ? "Enter your SSH user on atlas." : null,
    hostKey: step === 1 && tunnel && !hostKey.trim() ? "Enter the path to atlas's SSH host public key file." : null,
    trusted: step === 1 && tunnel && !trusted ? "Confirm the fingerprint matches atlas." : null,
    name: step === 2 && !machineName ? "Enter a name for this machine." : null,
  };
  const blocked = Object.values(errors).some(Boolean);
  const shown = (key: keyof typeof errors) => (tried ? errors[key] : null);

  // The demo doesn't decode invitations: it accepts the example's prefix and then shows example details,
  // and the copy around it says so rather than implying a real check.
  const pasteValid = pasted.trim().startsWith("canonfig-invite-v1:");
  const readPasted = () => {
    setPasteTried(true);
    if (pasteValid) setInvite("(pasted)");
  };
  // A pasted invitation is saved to ./canonfig-invite by the first command line.
  const invitePath = invite === null || invite === "(pasted)" ? "./canonfig-invite" : shq(invite);

  return (
    <Wizard
      title="Copy the setup from atlas"
      steps={["Invitation", "Connection", "This machine"]}
      step={step}
      onStep={(s) => {
        setTried(false);
        setStep(s);
      }}
      onBack={onBack}
      finalLabel="Join atlas"
      busyLabel="Joining…"
      blocked={blocked}
      onBlocked={() => {
        setTried(true);
        // The host key file lives under Advanced; its error must be visible.
        if (errors.hostKey) setAdvanced(true);
      }}
      busy={progress !== null && !done}
      onFinish={() => {
        setProgress(0);
        simulate(3000, setProgress, () => setDone(true));
      }}
      cli={[
        // `tunnel start` and `follower enroll` both read the invitation, and the tunnel needs it as a file,
        // so a pasted invitation is saved to one first.
        ...(invite === "(pasted)" ? ["cat > ./canonfig-invite   # paste the invitation, then Ctrl-D"] : []),
        ...(tunnel
          ? [
              `canonfig tunnel start --invitation ${invitePath} --ssh-host ${arg(sshHost, "<host>")} --ssh-user ${arg(sshUser, "<user>")} --ssh-host-key-file ${arg(hostKey, "<path>")}`,
            ]
          : []),
        `cat ${invitePath} | canonfig follower enroll --stdin --name ${arg(machineName, "<name>")} --profile ${shq(profileId)}`,
        ...(useSchedule ? ["canonfig schedule set --default"] : []),
      ]}
      done={
        done ? (
          <Finished
            title={`${machineName} now follows atlas`}
            action="Open Canonfig"
            onOpen={() => onDone({ role: "follower", name: machineName, profileId, tunnel, schedule: useSchedule })}
            next="Next: see what revision 7 would change here, before you apply it."
          >
            atlas can disconnect this machine on its own, without affecting the others. Canonfig hasn't changed any files here yet.
          </Finished>
        ) : undefined
      }
    >
      {step === 0 && (
        <div className="space-y-4">
          <p className="leading-relaxed text-muted-foreground">
            On atlas, create a single-use invitation file (<Mono>canonfig source invite</Mono> does the same), then copy it to this machine, for example with scp.
          </p>
          {invite === null ? (
            paste ? (
              <div className="space-y-2">
                <Field
                  label="Invitation contents"
                  htmlFor="ob-paste"
                  error={pasteTried && !pasteValid ? "That isn't the example invitation. In this demo, pasted invitations start with canonfig-invite-v1:" : null}
                >
                  <Textarea
                    id="ob-paste"
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        readPasted();
                      }
                    }}
                    placeholder="canonfig-invite-v1:…"
                    spellCheck={false}
                    aria-invalid={pasteTried && !pasteValid}
                    aria-describedby={pasteTried && !pasteValid ? "ob-paste-error" : undefined}
                    className="h-24 font-mono text-[12px]"
                  />
                </Field>
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={readPasted}>
                    Read invitation
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setPaste(false)}>
                    Choose a file instead
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className={cn("flex flex-col items-center rounded-lg border border-dashed px-6 py-8 text-center", shown("invite") ? "border-bad/60" : "border-border-strong")}>
                  <FileArrowUp className="size-5 text-muted-foreground" />
                  <p className="mt-3 font-medium">Add the invitation file</p>
                  <p className="mt-1 text-sm text-muted-foreground">Usually named canonfig-invite. This demo uses an example file.</p>
                  <div className="mt-4 flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setInvite("~/Downloads/canonfig-invite")}>
                      Use the example file
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setPaste(true)}>
                      Paste contents
                    </Button>
                  </div>
                </div>
                {shown("invite") && <FieldError>{shown("invite")}</FieldError>}
              </>
            )
          ) : (
            <div className="rounded-lg border border-border bg-raised/40 px-4 py-4">
              <div className="mb-3 flex items-center gap-2">
                <Check className="size-4 text-ok" />
                <span className="font-medium">Example invitation from atlas</span>
                <Button type="button" variant="ghost" size="xs" className="ml-auto text-muted-foreground" onClick={() => setInvite(null)}>
                  Use another
                </Button>
              </div>
              <Facts
                items={[
                  ["File", <Mono className="text-foreground">{invite === "(pasted)" ? "Pasted" : invite}</Mono>],
                  ["Endpoint", <Mono className="text-foreground">{machine.endpoint}</Mono>],
                  ["Expires", "In 52 minutes, or once used"],
                  [
                    <Term term="Follower Group">Groups</Term>,
                    <>
                      Can receive secrets <Mono>canonfig:secrets</Mono>
                    </>,
                  ],
                ]}
              />
            </div>
          )}
        </div>
      )}
      {step === 1 && (
        <div className="space-y-5">
          <p className="leading-relaxed text-muted-foreground">
            The invitation's address, 127.0.0.1, means “this machine”. An SSH tunnel forwards that port on this machine to atlas, so the address reaches atlas from here.
          </p>
          <label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50">
            <Switch checked={tunnel} onCheckedChange={setTunnel} />
            <span>
              <span className="font-medium">Connect through an SSH tunnel</span>
              <span className="mt-0.5 block text-sm text-muted-foreground">Uses the SSH access you already have to atlas. Canonfig opens the tunnel before each sync.</span>
            </span>
          </label>
          {tunnel && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Field label="SSH host" htmlFor="ob-host" error={shown("host")}>
                  <Input
                    id="ob-host"
                    value={sshHost}
                    // This matches atlas vouches for one exact identity, so editing host, user or key file withdraws it.
                    onChange={(e) => {
                      setSshHost(e.target.value);
                      setTrusted(false);
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!shown("host")}
                    aria-describedby={shown("host") ? "ob-host-error" : undefined}
                  />
                </Field>
                <Field label="SSH user" htmlFor="ob-user" error={shown("user")}>
                  <Input
                    id="ob-user"
                    value={sshUser}
                    onChange={(e) => {
                      setSshUser(e.target.value);
                      setTrusted(false);
                    }}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!shown("user")}
                    aria-describedby={shown("user") ? "ob-user-error" : undefined}
                  />
                </Field>
              </div>
              <div className={cn("rounded-lg border px-3.5 py-3", shown("trusted") ? "border-bad/60" : "border-border")}>
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  atlas's SSH host key, from <Mono>{hostKey}</Mono>
                  <Hint label="checking the SSH host key">Compare it with the output of “ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub” on atlas. Change the file under Advanced.</Hint>
                </div>
                <Mono className="mt-1 block text-foreground">ED25519 SHA256:Jx7qL2c9…vR0wPq4sE</Mono>
                <label className="mt-3 flex cursor-pointer items-center gap-2.5">
                  <Checkbox checked={trusted} onCheckedChange={(c) => setTrusted(c === true)} aria-invalid={!!shown("trusted")} />
                  This matches atlas
                </label>
              </div>
              {shown("trusted") && <FieldError>{shown("trusted")}</FieldError>}
              <Collapsible open={advanced} onOpenChange={setAdvanced}>
                <DisclosureTrigger>Advanced</DisclosureTrigger>
                <CollapsibleContent className="mt-3">
                  <Field
                    label="atlas's SSH host public key file"
                    htmlFor="ob-hostkey"
                    hint="A copy of /etc/ssh/ssh_host_ed25519_key.pub from atlas, for example made with scp."
                    error={shown("hostKey")}
                  >
                    <Input
                      id="ob-hostkey"
                      value={hostKey}
                      onChange={(e) => {
                        setHostKey(e.target.value);
                        setTrusted(false);
                      }}
                      spellCheck={false}
                      autoComplete="off"
                      aria-invalid={!!shown("hostKey")}
                      aria-describedby={shown("hostKey") ? "ob-hostkey-error" : undefined}
                      className="font-mono text-[12px]"
                    />
                  </Field>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </div>
      )}
      {step === 2 && (
        <div className="space-y-5">
          {progress === null ? (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Name for this machine" htmlFor="ob-mname" hint="Shown on atlas." error={shown("name")}>
                  <Input
                    id="ob-mname"
                    value={name}
                    // Collapse dash runs too: typing spaces one at a time turns "a  b" into "a--b" otherwise.
                    onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-"))}
                    onBlur={() => setName(machineName)}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={!!shown("name")}
                    aria-describedby={shown("name") ? "ob-mname-error" : undefined}
                  />
                </Field>
                <Field label="Profile to follow" htmlFor="ob-profile">
                  <Select value={profileId} onValueChange={setProfileId}>
                    <SelectTrigger id="ob-profile" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="workstation">Workstation (10 resources)</SelectItem>
                      <SelectItem value="minimal">Minimal (3 resources)</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3.5 py-3 hover:bg-raised/50">
                <Checkbox checked={useSchedule} onCheckedChange={(c) => setUseSchedule(c === true)} className="mt-px" />
                <span className="font-medium">Sync daily at 09:00, the profile's default schedule</span>
              </label>
              <p className="text-sm text-muted-foreground">
                Joining downloads <Term term="Profile Revision">revision 7</Term>, the latest setup atlas published, but changes no files. Before the first sync, you'll see exactly what would change.
              </p>
            </>
          ) : (
            <>
              <DitherProgress value={progress} running={!done} label="Joining atlas" />
              <RunList items={steps} progress={progress} />
            </>
          )}
        </div>
      )}
    </Wizard>
  );
}
