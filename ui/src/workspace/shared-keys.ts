import type { SkillSource } from "@/shared/metadata";
import type { Schedule } from "./schedule";
import { sharedKey } from "./store";
import type { Workspace } from "./workspace-types";

export const followerScheduleKey = sharedKey<Schedule | null>({ cadence: "default", days: [], time: "09:00" });
export const tunnelUpKey = sharedKey(true);
export const secretsRefreshKey = sharedKey<Workspace["secretsRefresh"]>({ busy: false, updated: "today at 08:45" });
export const serviceInstalledKey = sharedKey(true);
export const serviceSinceKey = sharedKey("Monday 08:12");
export const skillSourcesKey = sharedKey<SkillSource[]>([]);
export const skillBusyKey = sharedKey<string | null>(null);
