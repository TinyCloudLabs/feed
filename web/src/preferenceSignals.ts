import type { InteractionAction, InteractionRow } from "./types.ts";

const POSITIVE_ACTIONS = new Set<InteractionAction>(["more", "save", "promote"]);
const NEGATIVE_ACTIONS = new Set<InteractionAction>(["less", "already_knew", "wrong"]);

export interface TypeSignal {
  artifactType: string;
  positive: number;
  negative: number;
  total: number;
}

export interface PreferenceSignalSummary {
  total: number;
  positive: number;
  negative: number;
  notes: number;
  confidence: "none" | "early" | "directional";
  actionLines: string[];
  typeSignals: TypeSignal[];
}

function actionLabel(action: string): string {
  switch (action) {
    case "more":
      return "more";
    case "save":
      return "save";
    case "promote":
      return "promote";
    case "less":
      return "less";
    case "already_knew":
      return "already knew";
    case "wrong":
      return "wrong";
    default:
      return action;
  }
}

function confidenceFor(total: number, positive: number, negative: number): PreferenceSignalSummary["confidence"] {
  if (total === 0) return "none";
  const dominant = Math.max(positive, negative);
  return total >= 8 && dominant / total >= 0.6 ? "directional" : "early";
}

export function summarizePreferenceSignals(rows: readonly InteractionRow[]): PreferenceSignalSummary {
  const actionCounts = new Map<string, number>();
  const typeCounts = new Map<string, { positive: number; negative: number; total: number }>();
  let positive = 0;
  let negative = 0;
  let notes = 0;

  for (const row of rows) {
    actionCounts.set(row.action, (actionCounts.get(row.action) ?? 0) + 1);
    if (row.note?.trim()) notes += 1;

    const bucket = typeCounts.get(row.artifact_type) ?? { positive: 0, negative: 0, total: 0 };
    bucket.total += 1;
    if (POSITIVE_ACTIONS.has(row.action)) {
      positive += 1;
      bucket.positive += 1;
    } else if (NEGATIVE_ACTIONS.has(row.action)) {
      negative += 1;
      bucket.negative += 1;
    }
    typeCounts.set(row.artifact_type, bucket);
  }

  return {
    total: rows.length,
    positive,
    negative,
    notes,
    confidence: confidenceFor(rows.length, positive, negative),
    actionLines: [...actionCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([action, count]) => `${actionLabel(action)} ${count}`),
    typeSignals: [...typeCounts.entries()]
      .map(([artifactType, counts]) => ({ artifactType, ...counts }))
      .sort((a, b) => b.total - a.total || a.artifactType.localeCompare(b.artifactType)),
  };
}

export function confidenceText(confidence: PreferenceSignalSummary["confidence"]): string {
  switch (confidence) {
    case "none":
      return "No signal yet";
    case "early":
      return "Early signal";
    case "directional":
      return "Directional signal";
  }
}
