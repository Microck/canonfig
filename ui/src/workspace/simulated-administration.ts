import { useRef, useState } from "react";
import { toast } from "sonner";
import { APP_VERSION, DEMO } from "../shared/metadata";
import { LATEST_PATCH, agentPolicy, doctor, installers, selfUpdateSeed } from "../shared/data";
import { useSharedReader, useSharedState } from "./store";
import type { Workspace } from "./workspace-types";
import type { AdministrationSlice, DoctorCheck, InstallerChoice, SavedPolicy, SetupJournal } from "./administration-types";
import { updateGate } from "./update-gate";
import { transitionUpdate, type UpdateEvent, type UpdateLifecycle } from "./live/self-update";
import { TransitionError } from "../lib/state-machine";

const IN_DEMO = DEMO ? " in this demo workspace" : "";
const LINGER_FIX = "sudo loginctl enable-linger ubuntu";
const HARNESS_VERSION: Record<string, string> = { codex: "0.62", claude: "2.1" };
const POLICY_SEED: SavedPolicy = {
  mode: agentPolicy.mode, harness: {
    kind: "codex", model: "", executable: "", paths: agentPolicy.writablePaths,
    maximumInputBytes: agentPolicy.maxInputKb * 1024, origins: agentPolicy.origins,
  },
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
const INSTALLERS: readonly { name: string; path: string; status: "bound" | "not on this platform"; arguments: readonly string[] }[] = installers.map((installer) => ({
  ...installer, status: installer.status === "bound" ? "bound" as const : "not on this platform" as const, arguments: [],
}));

function startedNow() {
  return `today ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

export function useSimulatedAdministration(ws: Omit<Workspace, "admin">): AdministrationSlice {
  const [installed, setInstalled] = useSharedState("service-installed", true);
  const [boundInstallers, setBoundInstallers] = useSharedState("installers", INSTALLERS);
  const [serviceAction, setServiceAction] = useSharedState<"install" | "remove" | "restart" | null>("service-busy", null);
  const readServiceAction = useSharedReader<"install" | "remove" | "restart" | null>("service-busy", null);
  const [since, setSince] = useSharedState("service-since", "Monday 08:12");
  const [lingerMarked, setLingerMarked] = useSharedState("linger-marked", false);
  const [policy, setPolicy] = useSharedState("agent-policy", POLICY_SEED);
  const [journal, setJournal] = useSharedState("setup-journal", JOURNAL_SEED);
  const [checkingInstaller, setCheckingInstaller] = useSharedState<string | null>("installer-checking", null);
  const [checkedInstaller, setCheckedInstaller] = useState<string | null>(null);
  const [tunnelUp] = useSharedState("tunnel-up", true);
  const [version, setVersion] = useSharedState<UpdateLifecycle>("self-update", {
    kind: "ready", status: { enabled: selfUpdateSeed[ws.role].npmCli !== null, pending: false, platform: ws.role === "source" ? "linux" : "darwin", settings: { npmCli: selfUpdateSeed[ws.role].npmCli } }, checked: null,
  });
  const latestVersion = useRef(version);
  latestVersion.current = version;
  const sendVersion = (event: UpdateEvent) => {
    const next = transitionUpdate(latestVersion.current, event);
    latestVersion.current = next; setVersion(next);
    return next;
  };
  const updateStatus = "status" in version ? version.status : null;
  const checkedVersion = "checked" in version ? version.checked : null;
  const settings = updateStatus?.settings;
  const settingsRecord = settings !== null && typeof settings === "object" && !Array.isArray(settings) ? Object.fromEntries(Object.entries(settings)) : null;
  const npmCli = typeof settingsRecord?.npmCli === "string" ? settingsRecord.npmCli : null;
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
    : policy.harness?.kind === "custom" ? `${policy.harness.executable} found` : `${policy.harness?.executable || policy.harness?.kind} ${HARNESS_VERSION[policy.harness?.kind ?? ""]} found` };
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
      harnessConfigured: true,
      data: policy, loading: false, busy: false, error: null, harnessLoading: false, harnessError: null, savedMessage, saveState: { kind: "Idle" },
      harnessLabels: { codex: "codex 0.62", claude: "claude 2.1" },
      reload: () => toast("Agent settings refreshed", { description: "This demo uses the saved workspace policy." }),
      save: async (next) => { setPolicy(next); setSavedMessage("Policy and harness saved."); toast.success(`Agent policy saved${IN_DEMO}`); return true; },
    },
    installers: {
      data: boundInstallers, loading: false, busy: checkingInstaller !== null, error: null,
      checking: checkingInstaller, checked: checkedInstaller,
      // The demo "finds" any method it lists as unbound, at a plausible path.
      detected: INSTALLERS.filter((installer) => !boundInstallers.some((bound) => bound.name === installer.name) && installer.status === "bound")
        .map((installer) => ({ method: installer.name as InstallerChoice["method"], executable: installer.path, arguments: [] })),
      add: async (choice) => {
        setBoundInstallers([...boundInstallers.filter((bound) => bound.name !== choice.method), { name: choice.method, path: choice.executable, status: "bound", arguments: choice.arguments }]);
        setCheckedInstaller(choice.method);
        toast.success(`${choice.method} installer added${IN_DEMO}`);
        return true;
      },
      remove: (method) => { setBoundInstallers(boundInstallers.filter((bound) => bound.name !== method)); toast.success(`${method} installer removed${IN_DEMO}`); },
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
      lifecycle: version, data: updateStatus,
      current: APP_VERSION, npmCli, latest: checkedVersion?.candidate ?? null, loading: false,
      busy: version.kind === "changing", error: null, checked: checkedVersion,
      checking: version.kind === "changing" && version.action === "check", unfinished: gate.unfinished, progress: null,
      resume: () => { throw new TransitionError("Demo update", version.kind, "resume"); },
      reload: () => {
        const loading = sendVersion({ kind: "load" });
        if (loading.kind === "loading" && loading.status) sendVersion({ kind: "status", status: loading.status });
      },
      check: () => {
        sendVersion({ kind: "start", action: "check" });
        ws.later(() => sendVersion({ kind: "checked", checked: { current: APP_VERSION, candidate: LATEST_PATCH, status: LATEST_PATCH === APP_VERSION ? "current" : "available", detail: "Manual updates install the newest stable release in the current major, never a newer major." } }), 900);
      },
      enable: (npmCli, confirmIdle) => {
        if (!confirmIdle || gate.unfinished) throw new TransitionError("Demo update", version.kind, "enable without idle confirmation");
        sendVersion({ kind: "start", action: "enable" });
        sendVersion({ kind: "status", status: { enabled: true, pending: false, platform: ws.role === "source" ? "linux" : "darwin", settings: { npmCli } } });
        toast.success("Updates turned on");
      },
      disable: () => {
        if (gate.busyWith) { toast.error("Updates are still on", { description: "Stop running Canonfig commands before turning updates off." }); return; }
        sendVersion({ kind: "start", action: "disable" });
        sendVersion({ kind: "status", status: { enabled: false, pending: false, platform: ws.role === "source" ? "linux" : "darwin", settings: null } });
        toast("Updates turned off");
      },
      apply: () => {
        const candidate = checkedVersion?.candidate ?? APP_VERSION;
        sendVersion({ kind: "start", action: "apply" });
        sendVersion({ kind: "ticket", ticket: "demo-update" });
        sendVersion({ kind: "checked", checked: { current: APP_VERSION, candidate, status: gate.busyWith || gate.unfinished ? "deferred" : candidate === APP_VERSION ? "current" : "updated",
          detail: gate.busyWith || gate.unfinished ? "Another Canonfig operation needs attention. Stop running commands and recover any interrupted sync before installing." : "The demo simulated this update. No package was installed." } });
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
