import type { FeedArtifact, FeedArtifactProjection } from "../../../artifactory/skills/_shared/lib/feed-v1.ts";

export type FeedItem = {
  projection: FeedArtifactProjection;
  artifact: FeedArtifact | null;
  error?: string;
};

export function projectionLabel(projection: FeedArtifactProjection): string {
  const reasons = projection.reasonCodes.length > 0 ? projection.reasonCodes.join(", ") : "ranked";
  return `${projection.freshnessLabel} · ${projection.visibility} · ${reasons}`;
}

export function bodyPreview(artifact: FeedArtifact | null): string {
  if (!artifact) return "Artifact body has not been hydrated.";
  if (typeof artifact.body === "string") return artifact.body;
  if (artifact.body && typeof artifact.body === "object") {
    const record = artifact.body as Record<string, unknown>;
    for (const key of ["markdown", "text", "summary", "body"]) {
      if (typeof record[key] === "string") return record[key];
    }
  }
  return JSON.stringify(artifact.body, null, 2);
}

export function sortedFeed(items: readonly FeedItem[]): FeedItem[] {
  return [...items].sort((a, b) => {
    const rank = b.projection.rankScore - a.projection.rankScore;
    if (rank !== 0) return rank;
    return b.projection.publishedAt.localeCompare(a.projection.publishedAt);
  });
}
