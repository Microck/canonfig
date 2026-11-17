import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field } from "@/workspace/kit";

export interface TunnelAdvancedDraft {
  hostKey: string;
  sshPort: string;
  localPort: string;
  localHost: "127.0.0.1" | "::1";
  timeoutMilliseconds: string;
}

export const tunnelTimeoutError = (value: string) => /^\d+$/.test(value) && Number(value) >= 1_000 && Number(value) <= 300_000
  ? null : "Use a whole number from 1000 to 300000 milliseconds.";

export const tunnelPortsError = (draft: Pick<TunnelAdvancedDraft, "sshPort" | "localPort">) => [draft.sshPort, draft.localPort].every((value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535)
  ? null : "Use whole port numbers from 1 to 65535.";

/** Shared by enrollment and independent transport configuration. Paths belong to the GUI host. */
export function TunnelAdvancedFields({ value, onChange, showErrors = false }: {
  value: TunnelAdvancedDraft;
  onChange: (value: TunnelAdvancedDraft) => void;
  showErrors?: boolean;
}) {
  const portsError = showErrors ? tunnelPortsError(value) : null;
  return <div className="grid gap-4">
    <Field label="SSH host public key file" htmlFor="tunnel-host-key" description="Path on the machine running canonfig ui.">
      <Input id="tunnel-host-key" value={value.hostKey} onChange={(event) => onChange({ ...value, hostKey: event.target.value })} spellCheck={false} autoComplete="off" />
    </Field>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="SSH port" htmlFor="tunnel-ssh-port" error={portsError}>
        <Input id="tunnel-ssh-port" inputMode="numeric" value={value.sshPort} onChange={(event) => onChange({ ...value, sshPort: event.target.value })} aria-invalid={!!portsError} aria-describedby={portsError ? "tunnel-ssh-port-note" : undefined} />
      </Field>
      <Field label="Local tunnel port" htmlFor="tunnel-local-port" error={portsError}>
        <Input id="tunnel-local-port" inputMode="numeric" value={value.localPort} onChange={(event) => onChange({ ...value, localPort: event.target.value })} aria-invalid={!!portsError} aria-describedby={portsError ? "tunnel-local-port-note" : undefined} />
      </Field>
      <Field label="Local loopback address" htmlFor="tunnel-local-host">
        <Select value={value.localHost} onValueChange={(host) => { if (host === "127.0.0.1" || host === "::1") onChange({ ...value, localHost: host }); }}>
          <SelectTrigger id="tunnel-local-host" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="127.0.0.1">127.0.0.1 (IPv4)</SelectItem><SelectItem value="::1">::1 (IPv6)</SelectItem></SelectContent>
        </Select>
      </Field>
      <TunnelTimeoutField value={value.timeoutMilliseconds} onChange={(timeoutMilliseconds) => onChange({ ...value, timeoutMilliseconds })} showErrors={showErrors} />
    </div>
  </div>;
}

export function TunnelTimeoutField({ value, onChange, showErrors = false, optional = false }: { value: string; onChange: (value: string) => void; showErrors?: boolean; optional?: boolean }) {
  const error = showErrors && !(optional && value === "") ? tunnelTimeoutError(value) : null;
  return <Field label="Start timeout (ms)" htmlFor="tunnel-timeout" description={optional ? "1000 to 300000 ms, or blank for the saved timeout." : "1000 to 300000 ms."} error={error}>
    <Input id="tunnel-timeout" inputMode="numeric" value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={!!error} aria-describedby="tunnel-timeout-note" />
  </Field>;
}
