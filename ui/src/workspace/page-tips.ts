// First-visit tips: one card per page that has something non-obvious to
// learn, shown the first time the page opens and again from its "?" button.
// Every tip opens at that "?" (`page-help` in kit PageHeader), usually below it,
// like a popover from its trigger, which also shows where to find it again.
// Pages that follow common conventions (lists, settings forms) get none, so
// the tips stay rare enough to be read.
import type { TourStep } from "@/tour/tour";
import type { View } from "./store";

export const PAGE_TIPS: Record<"source" | "follower", Partial<Record<View, TourStep>>> = {
  source: {
    profile: {
      target: ["page-help"],
      title: "Reading this list",
      body: "Click an item to change it. A letter beside an item (A added, M modified, D removed) marks a change machines haven't received yet; it clears when you publish.",
    },
    machines: {
      target: ["page-help"],
      title: "Your machines at a glance",
      body: "The line colour shows each machine's state; hover a line to see why. Double-click a machine to open it, or use the brush to name it and pick an icon.",
    },
  },
  follower: {
    sync: {
      target: ["page-help"],
      title: "Nothing changes until you apply",
      body: "This list is exactly what the update would do here. Anything you edited on this machine is paused until you decide.",
    },
    overlays: {
      target: ["page-help"],
      title: "Settings only this machine keeps",
      body: "Pick a key and Canonfig stops managing it here. Whatever this machine has in the file stays.",
    },
  },
};
