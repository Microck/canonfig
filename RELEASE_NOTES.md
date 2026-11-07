# Canonfig v7.0.0

This release makes Canonfig's long-running operations recover correctly after
a crash, a lost connection, or a late reply. Each one now records exactly which
step it reached, so an interrupted operation resumes or reports what to do
instead of guessing.

## Breaking change: set machines up again

Canonfig 7.0.0 uses a new state format and does not read state written by 6.x.
On a machine that ran 6.x, the first 7.0.0 command that opens Canonfig state
(such as `canonfig status` or `canonfig sync`) refuses the old state and tells
you to move `state.sqlite` aside and set the machine up again. Nothing is
changed before that refusal.

Install with `npm install --global @microck/canonfig@7.0.0` on every machine,
then set up the Source and enroll each Follower again. A 7.0 Source and 6.x
Followers refuse each other, so update them all.

## Synchronization

- A sync is no longer marked complete before its last cleanup step finishes.
  An interrupted sync resumes that step on the next run.
- Rollback keeps the files it needs to restore your harness until the restore
  has finished, and reports a rollback that could not finish.
- A blocked action is reported as blocked, not as skipped.

## Machines and enrollment

- Setting up a Source can no longer leave it half initialized.
- Replacing or removing a Follower's enrollment keeps the old credential until
  the change is confirmed. If the Source cannot be reached to confirm a
  rollback, `canonfig status` and `canonfig doctor` show the pending rollback
  and the command that finishes it.
- If the Source restarts while a Follower is joining for the first time, the
  Follower drops the discarded enrollment and you can enroll again with a new
  invitation.
- Unattended run receipts now live in the state database.
- Shared secrets, tunnels, setup steps, skill updates, and the Source service
  install now each record their progress, so an interruption leaves a clear
  state.
- `canonfig self-update` reports an installed update as installed, with a
  warning, when only its follow-up bookkeeping failed.

## Browser interface

- Late replies can no longer overwrite newer edits in the profile editor,
  local items, secrets, policy, or onboarding.
- A follower command whose status check failed recovers instead of looking
  finished.
- A failed tool scan offers a retry, and a running revocation cannot be
  dismissed.
