import type { Plan, PlanEntry } from "./types.ts";

interface DiffLine { prefix: " " | "+" | "-"; text: string; }

function lineDiff(before: string, after: string): DiffLine[] {
  const left = before.split("\n");
  const right = after.split("\n");
  const cells = (left.length + 1) * (right.length + 1);
  if (cells > 1_500_000) {
    return [
      ...left.map((text): DiffLine => ({ prefix: "-", text })),
      ...right.map((text): DiffLine => ({ prefix: "+", text })),
    ];
  }

  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i] === right[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push({ prefix: " ", text: left[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      lines.push({ prefix: "-", text: left[i]! });
      i += 1;
    } else {
      lines.push({ prefix: "+", text: right[j]! });
      j += 1;
    }
  }
  while (i < left.length) lines.push({ prefix: "-", text: left[i++]! });
  while (j < right.length) lines.push({ prefix: "+", text: right[j++]! });
  return lines;
}

function diffEntry(entry: PlanEntry): string {
  const header = [`--- a/${entry.path}`, `+++ b/${entry.path}`];
  if (entry.action === "create") {
    return [...header, ...(entry.after ?? "").split("\n").map((line) => `+${line}`)].join("\n");
  }
  if (entry.action === "delete") {
    return [...header, ...(entry.before ?? "").split("\n").map((line) => `-${line}`)].join("\n");
  }
  if (entry.binary) return [...header, `Binary file ${entry.action}`].join("\n");
  return [...header, ...lineDiff(entry.before ?? "", entry.after ?? "").map((line) => `${line.prefix}${line.text}`)].join("\n");
}

export function formatPlanDiff(plan: Plan): string {
  return plan.entries
    .filter((entry) => entry.action !== "unchanged")
    .map(diffEntry)
    .join("\n\n");
}
