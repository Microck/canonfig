import { Schema } from "effect";

export const issueRepository = "Microck/canonfig";
export const issueTrackerUrl = `https://github.com/${issueRepository}/issues`;

export const GitHubAccount = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  login: Schema.NonEmptyString,
});

export const IssueReportingPreference = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ask") }),
  Schema.Struct({ status: Schema.Literal("disabled") }),
  Schema.Struct({ status: Schema.Literal("enabled"), account: GitHubAccount }),
]);
export type IssueReportingPreference = typeof IssueReportingPreference.Type;
