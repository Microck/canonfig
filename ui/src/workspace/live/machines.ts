import { useEffect, useRef, useState } from "react";
import { Schema } from "effect";
import { GuiEnrollment, GuiInvitationDownload, GuiMachines, GuiSetupStatus } from "../../../../src/gui/contract/enrollment";
import type { GuiSession, WorkspaceBackend } from "../../gui-client";
import type { ChangeGroupsRequest, MachinesSlice } from "../workspace-types";
import { resourceState, useLiveResource } from "./resource";

export function useLiveMachines(backend: WorkspaceBackend, session: GuiSession, revision: number, reload: () => void): Omit<MachinesSlice, "machinesMode"> {
  const source = session.role === "source";
  const inventory = useLiveResource(backend, "/api/machines", GuiMachines, source, revision);
  const enrollment = useLiveResource(backend, "/api/enrollment", GuiEnrollment, session.role === "follower", revision);
  const setup = useLiveResource(backend, "/api/setup", GuiSetupStatus, false, revision);
  const controller = useRef(new AbortController());
  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current.abort();
  }, []);
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
    enrollmentBackend: backend,
    ...(enrollment.data ? { enrollment: enrollment.data } : {}),
    machinesState: resourceState([inventory, enrollment]),
    machineStates: { inventory, enrollment, setup },
    sourceMachine: { hostname: source ? session.machineName : endpoint, folder: source ? session.folderPath : "", endpoint },
    followerSelf: { name: session.machineName, home: "", source: endpoint, local: [], overlays: [], kept: [] },
    selfFollower, endpoint, justJoined: enrollment.data?.pending ?? false,
    inviteOpen, setInviteOpen, followers,
    async revokeFollower(id) {
      await backend.request("/api/machines/revoke", Schema.Json, controller.current.signal, { method: "POST", body: { follower: id } });
      reload();
    },
    async createInvitation(input) {
      const invitation = await backend.request("/api/invitations", GuiInvitationDownload, controller.current.signal, { method: "POST", body: input });
      reload();
      return invitation;
    },
    invitations: (inventory.data?.invitations ?? []).filter((invitation) => !invitation.consumed).map((invitation, index) => ({
      id: `${invitation.endpoint}:${invitation.expiresAt}:${index}`,
      file: invitation.endpoint, name: "Single-use invitation", groups: [...invitation.groups], expires: invitation.expiresAt,
    })),
    syncing: [], changeGroups, setChangeGroups,
  };
}
