import { Schema } from "effect";

/** Exact origins exclude paths, user credentials and URL normalization. */
export const agentHarnessOriginProblem = (origin: string): string | undefined => {
  if (!URL.canParse(origin)) return `Invalid agent harness origin: ${origin}`;
  const url = new URL(origin);
  return url.protocol === "https:" && url.origin === origin
    ? undefined : `Agent harness origin must be an exact HTTPS origin: ${origin}`;
};

export const AgentSecretBindingSchema = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
  secret: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u)),
});

export const parseAgentSecretBinding = (value: string): typeof AgentSecretBindingSchema.Type => {
  const separator = value.indexOf("=");
  const binding = { name: separator < 0 ? "" : value.slice(0, separator), secret: separator < 0 ? "" : value.slice(separator + 1) };
  if (!Schema.is(AgentSecretBindingSchema)(binding)) {
    throw new Error("Invalid secret binding; expected ENV_NAME=shared-secret-name");
  }
  return binding;
};
