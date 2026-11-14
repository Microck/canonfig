import { Schema } from "effect";

/** Read-only network discovery, not permission to serve or enroll. */
export const TailnetReport = Schema.Struct({
  installed: Schema.Boolean,
  ready: Schema.Boolean,
  backendState: Schema.String,
  addresses: Schema.Array(Schema.String),
  dnsName: Schema.optional(Schema.String),
  tailnet: Schema.optional(Schema.String),
  controlUrl: Schema.optional(Schema.String),
  httpsAvailable: Schema.Boolean,
  userspace: Schema.Boolean,
  detail: Schema.String,
});
export type TailnetReport = typeof TailnetReport.Type;
