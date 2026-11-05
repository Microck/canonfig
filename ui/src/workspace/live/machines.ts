import { useState } from "react";
import { GuiEnrollment, GuiMachines, GuiSetupStatus } from "../../../../src/gui/contract/enrollment";
import type { GuiSession, WorkspaceBackend } from "../../gui-client";
import type { ChangeGroupsRequest, MachinesSlice } from "../workspace-types";
import { notImplemented, resourceState, useLiveResource } from "./resource";

/** Phase 2d checklist: operation forms must preserve invitation envelopes, plan digests and explicit approval.
 * notImplemented: setFollowers (revoke), setInvitations (create), invitation download,
 * replacement enrollment, setup plan/approve/apply, enrollment tunnel.
 * Delete ui/src/live/enrollment.tsx once the shared onboarding and machine forms are wired.
 */
export const MACHINES_NOT_IMPLEMENTED = ["setFollowers", "setInvitations", "invitation download", "replacement enrollment", "setup plan/approve/apply", "enrollment tunnel"] as const;

export function useLiveMachines(backend: WorkspaceBackend, session: GuiSession, revision: number): Omit<MachinesSlice, "machinesMode"> {
  const source = session.role === "source";
  const inventory = useLiveResource(backend, "/api/machines", GuiMachines, source, revision);
  const enrollment = useLiveResource(backend, "/api/enrollment", GuiEnrollment, session.role === "follower", revision);
  const setup = useLiveResource(backend, "/api/setup", GuiSetupStatus, false, revision);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [changeGroups, setChangeGroups] = useState<ChangeGroupsRequest | null>(null);
  const endpoint = enrollment.data?.source.endpoint ?? "";
  const followers = (inventory.data?.followers ?? []).map((entry) => ({
    id: entry.id, name: entry.name, groups: [...entry.groups],
    note: entry.revoked ? "Revoked" : entry.pending ? "Enrollment pending" : "Enrolled",
  }));
  const selfFollower = enrollment.data ? {
    id: enrollment.data.follower.id, name: enrollment.data.follower.name,
    groups: [...enrollment.data.follower.groups],
    note: enrollment.data.follower.revoked ? "Revoked" : enrollment.data.pending ? "Enrollment pending" : "Enrolled",
  } : undefined;
  return {
    machinesState: resourceState([inventory, enrollment]),
    machineStates: { inventory, enrollment, setup },
    sourceMachine: { hostname: source ? session.machineName : endpoint, folder: source ? session.folderPath : "", endpoint },
    followerSelf: { name: session.machineName, home: "", source: endpoint, local: [], overlays: [], kept: [] },
    selfFollower, endpoint, justJoined: enrollment.data?.pending ?? false,
    inviteOpen, setInviteOpen, followers,
    setFollowers: () => notImplemented("setFollowers"),
    invitations: (inventory.data?.invitations ?? []).filter((invitation) => !invitation.consumed).map((invitation, index) => ({
      id: `${invitation.endpoint}:${invitation.expiresAt}:${index}`,
      file: "", name: "", groups: [...invitation.groups], expires: invitation.expiresAt,
    })),
    setInvitations: () => notImplemented("setInvitations"), syncing: [], changeGroups, setChangeGroups,
  };
}
