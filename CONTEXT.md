# Canonfig

Canonfig keeps declared AI agent configuration aligned across a set of machines. One machine owns the desired configuration, while follower machines consume it without becoming additional authorities.

## Language

**Source Machine**:
The machine that owns canonical configuration state for a Canonfig installation.
_Avoid_: Central authority machine, main machine

**Follower Machine**:
A machine that receives canonical configuration state from the Source Machine while retaining explicitly local configuration.
_Avoid_: Client machine, replica

**Machine Profile**:
A versioned declaration of the configuration state that Follower Machines should have.
_Avoid_: Bundle, snapshot, manifest

**Observed State**:
The configuration state that Canonfig finds on a machine at a point in time.
_Avoid_: Current profile, actual profile

**Local Overlay**:
Configuration owned by one Follower Machine that is combined with canonical state but never sent back to the Source Machine.
_Avoid_: Local override, follower state

**Human Action Required**:
A synchronization outcome that identifies a step only a person can complete before the desired configuration can be reached.
_Avoid_: Sync failure, unsupported operation

**Configuration Agent**:
An AI agent that resolves configuration work for which Canonfig has no unambiguous deterministic action.
_Avoid_: Installer, setup bot

**Synchronization Schedule**:
The declared cadence at which a Follower Machine checks for and applies an approved Machine Profile revision.
_Avoid_: Immediate sync, background polling

**Follower Group**:
A named set of Follower Machines that share configuration in addition to the base Machine Profile.
_Avoid_: Per-machine profile, follower branch

**Profile Resource**:
A named item of desired configuration within a Machine Profile, classified by the behavior needed to reach and verify it.
_Avoid_: Generic resource, profile entry

**Installation Recipe**:
A platform-specific, deterministic description of how a declared tool is installed, configured, and verified.
_Avoid_: Install script, setup command

**Profile Change Proposal**:
A candidate Machine Profile change produced by discovery or a Configuration Agent before publication policy is applied.
_Avoid_: Automatic profile edit, follower update

**Follower Drift**:
A difference between a follower-owned copy of a canonical resource and the exact revision Canonfig last applied to it.
_Avoid_: Local Overlay, follower update

**Convergence**:
The state in which every required Profile Resource on a Follower Machine matches the Machine Profile and passes verification.
_Avoid_: Successful sync, up to date

**Profile Revision**:
An immutable, validated publication of a Machine Profile that Follower Machines can authenticate and apply.
_Avoid_: Latest profile, bundle version

**Follower Identity**:
The independently revocable identity granted to one Follower Machine during enrollment.
_Avoid_: Shared token, machine fingerprint

**Synchronization Run**:
One planned and recorded attempt to move a Follower Machine from Observed State toward a Profile Revision.
_Avoid_: Background job, sync command

**Apply Policy**:
The declared rule that determines how Canonfig treats differences between a Profile Resource, Observed State, and follower-owned changes.
_Avoid_: Sync mode, overwrite flag

**Applied Resource Record**:
A Follower Machine's record of the exact Profile Resource revision and content Canonfig last applied.
_Avoid_: Baseline, cached resource

**Agent Task**:
A bounded request that gives a Configuration Agent the desired outcome, observed evidence, allowed actions, and required proof of completion.
_Avoid_: Prompt, autonomous job
