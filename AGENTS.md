## When CLI changes need GUI support

- When adding a CLI command or a flag that changes what users can do, check the GUI for each applicable role (Source and Follower). If users need it for routine setup, operation, review, or recovery, add or extend a workflow in the live GUI in the same change. Preserve role and safety checks, and let users complete the task and verify the outcome. An existing GUI workflow counts if it already meets that need.
- Keep scripting, machine-readable output, process launch and supervision, and low-level overrides in the CLI by default. For a CLI-only decision, document why and give users the command to run or the equivalent GUI workflow. If needed GUI work is deferred, record why and link a follow-up issue.
- Record the coverage decision in the CLI/GUI capability matrix. [Issue #323](https://github.com/Microck/canonfig/issues/323)
