// First-visit tips: one card per page that has something non-obvious to
// learn, shown the first time the page opens and again from its "?" button.
// Every tip targets that "?" (`page-help` in kit PageHeader) and opens below it,
// like a popover from its trigger, as far down or across as it must go to keep
// clear of open details, header actions and the page's controls (tour.tsx placeTip).
// Pages that follow common conventions (lists, settings forms) get none, so
// the tips stay rare enough to be read.
import type { TourStep } from "@/tour/tour";
import type { View } from "./store";

export const PAGE_TIPS: Record<"source" | "follower", Partial<Record<View, TourStep>>> = {
  source: {
    profile: {
      target: ["page-help"],
      title: "Reading this list",
      body: "Each item is a file or a canonfig.jsonc entry in ~/.canonfig. Click one to change it. A letter beside an item (A added, M modified, D removed) marks a change machines haven't received yet; it clears when you publish.",
    },
    machines: {
      target: ["page-help"],
      title: "Your machines at a glance",
      body: "The line colour shows each machine's state; hover a line to see why. Double-click a machine to open it, or use the brush to name it and pick an icon.",
    },
    backups: {
      target: ["page-help"],
      title: "Restore any copy",
      body: "Test a copy without changing anything, restore it into a new folder for a new machine, or put your Canonfig folder back. Before Canonfig holds the harness files Canonfig replaced.",
    },
  },
  follower: {
    sync: {
      target: ["page-help"],
      title: "Nothing changes until you apply",
      body: "This list is exactly what the update would do here. A file you edited stays as you left it, and what Canonfig writes from it holds until the edit moves to your local folder or the Source publishes it.",
    },
    local: {
      target: ["page-help"],
      title: "Items only this machine has",
      body: "Everything here lives in ~/.canonfig/local and never goes to the Source. Canonfig adds it to what the Source publishes, but only in the categories the Source allows.",
    },
    backups: {
      target: ["page-help"],
      title: "Restore any copy",
      body: "Test a copy without changing anything, or restore it into a new folder for a new machine. Before Canonfig holds the harness files Canonfig replaced; putting one back stops syncing that harness here.",
    },
  },
};
