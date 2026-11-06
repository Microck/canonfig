import { useRef, useState } from "react";
import { toast } from "sonner";
import { APP_VERSION, DEMO } from "../shared/metadata";
import { LATEST_PATCH, agentPolicy, doctor, installers, selfUpdateSeed } from "../shared/data";
import { useSharedReader, useSharedState } from "./store";
import type { Workspace } from "./workspace-types";
import type { AdministrationSlice, DoctorCheck, SavedPolicy, SetupJournal } from "./administration-types";
import { updateGate } from "./update-gate";

const IN_DEMO = DEMO ? " in this demo workspace" : "";
const LINGER_FIX = "sudo loginctl enable-linger ubuntu";
const HARNESS_VERSION: Record<string, string> = { codex: "0.62", claude: "2.1" };
const POLICY_SEED: SavedPolicy = {
  mode: agentPolicy.mode, harness: "codex", model: "", executable: "", args: [], paths: agentPolicy.writablePaths,
  maximumInputBytes: agentPolicy.maxInputKb * 1024, origins: agentPolicy.origins,
};
const JOURNAL_SEED: SetupJournal = { phase: "planned", at: 0 };
const SETUP_STEPS = [
  { id: "keys", label: "Initialize the Source", detail: "Signing key in Secret Service" },
  { id: "state", label: "Create the Canonfig folder", detail: "~/.canonfig" },
  { id: "profile", label: "Write canonfig.jsonc with your harnesses", detail: "~/.canonfig/canonfig.jsonc" },
  { id: "import", label: "Import what you chose from your harnesses", detail: "Into ~/.canonfig" },
  { id: "service", label: "Install source service", detail: "systemd user unit" },
  { id: "linger", label: "You turn on linger", detail: LINGER_FIX },
];
const INSTALLERS = installers.map((installer) => ({
  ...installer, status: installer.status === "bound" ? "bound" as const : "not on this platform" as const, arguments: [],
}));

function startedNow() {
  return `today ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

export function useSimulatedAdministration(ws: Omit<Workspace, "admin">): AdministrationSlice {
  const [installed, setInstalled] = useSharedState("service-installed", true);
  const [serviceAction, setServiceAction] = useSharedState<"install" | "remove" | "restart" | null>("service-busy", null);
  const readServiceAction = useSharedReader<"install" | "remove" | "restart" | null>("service-busy", null);
  const [since, setSince] = useSharedState("service-since", "Monday 08:12");
  const [lingerMarked, setLingerMarked] = useSharedState("linger-marked", false);
  const [policy, setPolicy] = useSharedState("agent-policy", POLICY_SEED);
  const [journal, setJournal] = useSharedState("setup-journal", JOURNAL_SEED);
  const [checkingInstaller, setCheckingInstaller] = useSharedState<string | null>("installer-checking", null);
  const [checkedInstaller, setCheckedInstaller] = useState<string | null>(null);
  const [tunnelUp] = useSharedState("tunnel-up", true);
  const [version, setVersion] = useSharedState<{ npmCli: string | null; latest: string | null }>("self-update", { npmCli: selfUpdateSeed[ws.role].npmCli, latest: null });
  const [checkingVersion, setCheckingVersion] = useSharedState<object | null>("self-update-checking", null);
  const readCheckingVersion = useSharedReader<object | null>("self-update-checking", null);
  const [appliedVersion, setAppliedVersion] = useSharedState<AdministrationSlice["version"]["checked"]>("self-update-applied", null);
  const [skillBusy] = useSharedState<string | null>("skill-busy", null);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [doctorProgress, setDoctorProgress] = useState(100);
  const [savedMessage, setSavedMessage] = useState("");
  const doctorRun = useRef(false);
  const latestChecks = useRef<readonly DoctorCheck[]>([]);

  const missing = ws.harnesses.filter((harness) => harness.listed && !harness.installed && !harness.excluded);
  const harnessCheck: Partial<DoctorCheck> = missing.length ? {
    result: "warn", detail: `Not installed: ${missing.map((harness) => harness.name).join(", ")} ${missing.length === 1 ? "gets" : "get"} nothing on this machine`,
    fix: { why: "Install it, or exclude it on this machine so Canonfig stops reporting it.", command: `canonfig harnesses exclude ${missing[0]!.id}` },
  } : { detail: `${ws.harnesses.filter((harness) => harness.listed && harness.installed && !harness.excluded).length} listed harnesses installed` };
  const agent: Partial<DoctorCheck> = { detail: policy.mode === "deterministic-only" ? "Not used: agent policy is deterministic only"
    : policy.harness === "custom" ? `${policy.executable} found` : `${policy.executable || policy.harness} ${HARNESS_VERSION[policy.harness ?? ""]} found` };
  const port = new URL(ws.endpoint).port;
  const overrides: Record<string, Partial<DoctorCheck>> = ws.role === "source" ? {
    "Source service": installed ? { detail: `Listening on ${new URL(ws.endpoint).host}` } : {
      result: "warn", detail: "Not installed: other machines can't fetch revisions",
      fix: { why: "Install it so other machines can fetch new revisions.", command: `canonfig source service install${port === "17342" ? "" : ` --port ${port}`}` },
    },
    Linger: lingerMarked ? { result: "ok", detail: "On: you marked it done in setup" }
      : { fix: { why: "To keep user services running after you log out, run this yourself. Canonfig won't change it.", command: LINGER_FIX } },
    "Configuration Agent": agent, Harnesses: harnessCheck,
  } : {
    "Credential storage": { detail: "macOS Keychain unlocked" }, "Native scheduler": { detail: "launchd user agent" },
    "Source service": !ws.tunnelConfigured ? { check: "SSH tunnel", detail: "Not set up" }
      : tunnelUp ? { check: "SSH tunnel", detail: "Connected to atlas" } : {
        check: "SSH tunnel", result: "warn", detail: "Stopped: updates fail until you start it",
        fix: { why: "Start it so this machine can fetch updates from atlas.", command: "canonfig tunnel start" },
      },
    Linger: { result: "ok", detail: "Not used on macOS" }, "Package managers": { detail: "brew and npm found" },
    "Configuration Agent": agent, Harnesses: harnessCheck,
  };
  const checks = doctor.map((check) => ({ ...check, ...overrides[check.check] })).filter((check) => ws.role !== "source" || installed || check.check !== "Linger");
  latestChecks.current = checks;
  const gate = updateGate({ role: ws.role, serviceInstalled: installed, serviceBusy: serviceAction !== null, setupApplying: journal.phase === "applying",
    publishing: ws.publishing, syncRunning: ws.phase === "running", syncInterrupted: ws.interrupted, skillBusy: skillBusy !== null });
  const changeService = (action: "install" | "remove" | "restart") => {
    if (readServiceAction()) return;
    setServiceAction(action);
    ws.later(() => {
      setInstalled(action !== "remove");
      if (action !== "remove") setSince(startedNow());
      setServiceAction(null);
      toast.success(`Source service ${action === "remove" ? "removed" : action === "restart" ? "restarted" : "installed"}${IN_DEMO}`);
    }, 800);
  };
  return {
    service: {
      data: {
        state: installed ? "running" : "not-installed", platform: "linux", mechanism: "systemd-user-service",
        serviceName: "canonfig-source.service", endpoint: ws.endpoint,
        manager: { installed, matches: installed, enabled: installed, active: installed, state: installed ? "running" : "not-installed" },
        serving: installed, supportedModes: "user", linger: lingerMarked, logs: "journalctl --user -u canonfig-source.service", detail: "",
      },
      since, lingerMarked, loading: false, busy: serviceAction !== null, error: null, action: serviceAction,
      reload: () => toast("Service status refreshed", { description: "This demo uses simulated service state." }),
      install: () => changeService("install"), remove: () => changeService("remove"), restart: () => changeService("restart"),
    },
    agent: {
      configured: true,
      harnessWritable: true,
      harnessConfigured: true,
      data: policy, loading: false, busy: false, error: null, harnessLoading: false, harnessError: null, savedMessage,
      harnessLabels: { codex: "codex 0.62", claude: "claude 2.1" },
      reload: () => toast("Agent settings refreshed", { description: "This demo uses the saved workspace policy." }),
      save: async (next) => { setPolicy(next); setSavedMessage("Policy and harness saved."); toast.success(`Agent policy saved${IN_DEMO}`); return true; },
    },
    installers: {
      data: INSTALLERS, loading: false, busy: checkingInstaller !== null, error: null,
      checking: checkingInstaller, checked: checkedInstaller, suggestions: [],
      reload: () => toast("Installer bindings refreshed", { description: "This demo uses simulated installer bindings." }),
      check: (method) => {
        if (checkingInstaller) return;
        setCheckingInstaller(method);
        ws.later(() => { setCheckingInstaller(null); setCheckedInstaller(method); toast.success(`${method} check passed${IN_DEMO}`, { description: INSTALLERS.find((installer) => installer.name === method)?.path }); }, 600);
      },
    },
    doctor: {
      data: checks, loading: false, busy: doctorRunning, error: null,
      status: checks.some((check) => check.result === "warn") ? "degraded" : "healthy", progress: doctorProgress,
      reload: () => toast("Health results refreshed", { description: "This demo reflects the current workspace settings." }),
      run: () => {
        if (doctorRun.current) return;
        doctorRun.current = true;
        setDoctorRunning(true); setDoctorProgress(0);
        const advance = (progress: number): void => ws.later(() => {
          setDoctorProgress(progress);
          if (progress < 100) { advance(progress + 10); return; }
          doctorRun.current = false; setDoctorRunning(false); ws.reach("health-check");
          const final = latestChecks.current;
          const warned = final.filter((check) => check.result === "warn");
          toast("Health check finished", { description: `${final.length - warned.length} passed${warned.length ? `\nWarning: ${warned.map((check) => {
            const [state, effect] = check.detail.split(": ");
            return effect ? `${effect.charAt(0).toUpperCase()}${effect.slice(1)} (${check.check.toLowerCase()} ${state!.toLowerCase()})` : check.check;
          }).join(", ")}` : ""}` });
        }, 120);
        advance(10);
      },
    },
    version: {
      data: { enabled: version.npmCli !== null, pending: false, platform: ws.role === "source" ? "linux" : "darwin", settings: version.npmCli ? { npmCli: version.npmCli } : null },
      current: APP_VERSION, npmCli: version.npmCli, latest: version.latest, loading: false, busy: checkingVersion !== null, error: null,
      checked: appliedVersion ?? (version.latest ? { current: APP_VERSION, candidate: version.latest, status: version.latest === APP_VERSION ? "current" : "available", detail: `Only patches in the ${APP_VERSION.split(".").slice(0, 2).join(".")} line are offered.` } : null),
      checking: checkingVersion !== null, unfinished: gate.unfinished, progress: null,
      reload: () => toast("Update status refreshed", { description: "This demo uses simulated release data." }),
      check: () => {
        if (readCheckingVersion()) return;
        setAppliedVersion(null);
        const run = {}; setCheckingVersion(run);
        ws.later(() => {
          if (readCheckingVersion() !== run) return;
          setCheckingVersion(null); setVersion((previous) => ({ ...previous, latest: LATEST_PATCH }));
          toast(LATEST_PATCH === APP_VERSION ? "Canonfig is up to date" : `Canonfig ${LATEST_PATCH} is available`, { description: `This machine has ${APP_VERSION}.` });
        }, 900);
      },
      enable: (npmCli, confirmIdle) => {
        if (!confirmIdle) return;
        if (gate.unfinished) { toast.error("Recover or abandon the interrupted sync first."); return; }
        setAppliedVersion(null);
        setVersion((previous) => ({ ...previous, npmCli }));
        toast.success("Updates turned on", { description: `Start the services and schedules you stopped again.${DEMO ? "\nSaved in this demo workspace." : ""}` });
      },
      disable: () => {
        if (gate.busyWith) {
          toast.error("Updates are still on", { description: gate.busyWith === "service" ? "The source service is running.\nStop it first, then turn updates off."
            : gate.busyWith === "sync" ? "A sync is running.\nTurn updates off once it finishes." : "Another Canonfig command is running.\nTurn updates off once it finishes." });
          return;
        }
        setCheckingVersion(null); setVersion({ npmCli: null, latest: null });
        setAppliedVersion(null);
        toast("Updates turned off", { description: "Backups of earlier versions and the update records stay on this machine." });
      },
      apply: () => {
        if (readCheckingVersion()) return;
        const candidate = version.latest ?? APP_VERSION;
        setAppliedVersion({
          current: APP_VERSION, candidate,
          status: gate.busyWith || gate.unfinished ? "deferred" : candidate === APP_VERSION ? "current" : "updated",
          detail: gate.busyWith || gate.unfinished ? "Another Canonfig operation needs attention. Stop running commands and recover any interrupted sync before installing." : "The demo simulated this update. No package was installed.",
        });
      },
    },
    setup: {
      journal, steps: SETUP_STEPS, journalLabel: "Journal #3", lingerCommand: LINGER_FIX,
      approve: () => setJournal({ phase: "approved", at: 0 }),
      apply: () => {
        setJournal({ phase: "applying", at: 0 });
        const advance = (index: number): void => ws.later(() => {
          if (SETUP_STEPS[index - 1]?.id === "service") { setInstalled(true); if (!installed) setSince(startedNow()); }
          if (index < SETUP_STEPS.length - 1) { setJournal({ phase: "applying", at: index }); advance(index + 1); return; }
          setJournal({ phase: "paused", at: index });
          toast("Setup paused at a step that needs you", { description: `Run ${LINGER_FIX}, then resume.` });
        }, 500);
        advance(1);
      },
      resume: () => { setJournal({ phase: "complete", at: SETUP_STEPS.length - 1 }); setLingerMarked(true); toast.success(`Setup complete${IN_DEMO}`, { description: "You marked the linger step done.\nCanonfig didn't check it." }); },
    },
  };
}
