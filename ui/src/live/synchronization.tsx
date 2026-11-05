import type { LiveScreen } from "./routes";
import {
  SynchronizationScreen, SynchronizationSchedule, SynchronizationLocal, SynchronizationBackups,
  SynchronizationSecrets, SynchronizationTunnel, SynchronizationEnrollment,
} from "../workspace/synchronization/screens";

export const synchronizationScreens: ReadonlyArray<LiveScreen> = [
  { title: "Sync", path: (role) => role === "follower" ? "/follower/sync" : undefined, render: ({ backend }) => <SynchronizationScreen backend={backend} /> },
  { title: "Schedule", path: (role) => role === "follower" ? "/follower/schedule" : undefined, render: ({ backend }) => <SynchronizationSchedule backend={backend} /> },
  { title: "Local settings", path: (role) => role === "follower" ? "/follower/local-settings" : undefined, render: ({ backend }) => <SynchronizationLocal backend={backend} /> },
  { title: "Backups", path: (role) => role === "follower" ? "/follower/backups" : undefined, render: ({ backend }) => <SynchronizationBackups backend={backend} /> },
  { title: "Secrets", path: (role) => role === "follower" ? "/follower/secrets" : undefined, render: ({ backend }) => <SynchronizationSecrets backend={backend} /> },
  { title: "Tunnel", path: (role) => role === "follower" ? "/follower/settings/tunnel" : undefined, render: ({ backend }) => <SynchronizationTunnel backend={backend} /> },
  { title: "Enrollment", path: (role) => role === "follower" ? "/follower/settings/enrollment" : undefined, render: ({ backend }) => <SynchronizationEnrollment backend={backend} /> },
];
