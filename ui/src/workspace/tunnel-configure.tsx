import { useState, type Dispatch, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Mono } from "@/shared/shared";
import { TunnelAdvancedFields, tunnelPortsError, tunnelTimeoutError, type TunnelAdvancedDraft } from "@/shared/tunnel-fields";
import type { GuiInvitationInspection } from "../../../src/gui/contract/enrollment";
import type { FollowerLive } from "./follower-types";
import { Field, SectionLabel, SettingRow, settingsGroup } from "./kit";

interface TunnelConfigureDraft {
  envelope: string;
  inspection: GuiInvitationInspection | null;
  sshHost: string;
  sshUser: string;
  advanced: TunnelAdvancedDraft;
  trusted: boolean;
  tried: boolean;
}

interface TunnelConfigureForm {
  state: TunnelConfigureDraft;
  setState: Dispatch<SetStateAction<TunnelConfigureDraft>>;
  reset: () => void;
}

const emptyDraft: TunnelConfigureDraft = {
  envelope: "", inspection: null, sshHost: "", sshUser: "",
  advanced: { hostKey: "./source-host-key.pub", sshPort: "22", localPort: "17342", localHost: "127.0.0.1", timeoutMilliseconds: "30000" },
  trusted: false, tried: false,
};

/** The screen owns private draft state above Body's loading/remount boundary. */
export function useTunnelConfigureDraft(): TunnelConfigureForm {
  const [state, setState] = useState(emptyDraft);
  return { state, setState, reset: () => setState(emptyDraft) };
}

/** Configuring transport never enrolls, replaces an identity or changes the enrolled Source endpoint. */
export function TunnelConfigure({ live, configured, onCancel, form }: { live: FollowerLive; configured: boolean; onCancel: () => void; form: TunnelConfigureForm }) {
  const { state, setState } = form;
  const { envelope, inspection, sshHost, sshUser, advanced: draft, trusted, tried } = state;
  const update = (patch: Partial<TunnelConfigureDraft>) => setState((current) => ({ ...current, ...patch }));
  const busy = live.action.loading;
  const invalid = !inspection || !sshHost.trim() || !sshUser.trim() || !draft.hostKey.trim() || !trusted || tunnelPortsError(draft) || tunnelTimeoutError(draft.timeoutMilliseconds);
  const inspect = async () => {
    const result = await live.inspectTunnelInvitation(envelope);
    if (!result) return;
    const endpoint = new URL(result.endpoint);
    setState((current) => ({ ...current, inspection: result, trusted: false, advanced: { ...current.advanced, localPort: endpoint.port || "443", localHost: endpoint.hostname === "[::1]" ? "::1" : "127.0.0.1" } }));
  };
  return <form className="mt-6 grid max-w-2xl gap-4" onSubmit={(event) => {
    event.preventDefault(); update({ tried: true });
    if (invalid || busy) return;
    live.configureTunnel({ envelope, sshHost, sshUser, sshPort: Number(draft.sshPort), sshHostKeyPath: draft.hostKey, localPort: Number(draft.localPort), localHost: draft.localHost, timeoutMilliseconds: Number(draft.timeoutMilliseconds), trustConfirmed: true });
  }}>
    <SectionLabel>{configured ? "Change tunnel" : "Configure tunnel"}</SectionLabel>
    <fieldset disabled={busy} className="grid min-w-0 gap-4">
      {!inspection ? <>
        <Field label="Paste invitation" htmlFor="tunnel-invitation">
          <Textarea id="tunnel-invitation" value={envelope} onChange={(event) => update({ envelope: event.target.value, trusted: false })} spellCheck={false} autoComplete="off" />
        </Field>
        <div><Button type="button" variant="outline" disabled={!envelope.trim()} onClick={() => { void inspect(); }}>Inspect invitation</Button></div>
      </> : <div><Button type="button" variant="outline" onClick={() => update({ envelope: "", inspection: null, trusted: false })}>Use another invitation</Button></div>}
      {inspection && <div className={settingsGroup}>
        <SettingRow title="Source endpoint"><Mono className="break-all">{inspection.endpoint}</Mono></SettingRow>
        <SettingRow title="Source fingerprint"><Mono className="break-all">{inspection.sourceFingerprint}</Mono></SettingRow>
        <SettingRow title="TLS fingerprint"><Mono className="break-all">{inspection.tlsFingerprint}</Mono></SettingRow>
      </div>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="SSH address" htmlFor="tunnel-host"><Input id="tunnel-host" value={sshHost} onChange={(event) => update({ sshHost: event.target.value, trusted: false })} spellCheck={false} autoComplete="off" /></Field>
        <Field label="SSH username" htmlFor="tunnel-user"><Input id="tunnel-user" value={sshUser} onChange={(event) => update({ sshUser: event.target.value, trusted: false })} spellCheck={false} autoComplete="off" /></Field>
      </div>
      <details open={tried && (!!tunnelPortsError(draft) || !!tunnelTimeoutError(draft.timeoutMilliseconds)) ? true : undefined}>
        <summary className="cursor-pointer text-sm">Advanced</summary>
        <div className="mt-4"><TunnelAdvancedFields value={draft} showErrors={tried} onChange={(value) => update({ advanced: value, trusted: false })} /></div>
      </details>
      <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm"><Checkbox checked={trusted} onCheckedChange={(value) => update({ trusted: value === true })} />I independently verified the fingerprints and SSH host key.</label>
      {tried && invalid && <p role="alert" className="text-sm text-bad">Complete the fields and confirmation.</p>}
    </fieldset>
    <div className="grid gap-2">
      {configured && <p className="text-sm text-muted-foreground">A failed start can leave this machine disconnected.</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Working…" : configured ? "Replace and start tunnel" : "Configure and start tunnel"}</Button>
      </div>
    </div>
  </form>;
}
