import type { FeedArtifact } from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import type { FeedItemProjection } from "../../shared/feed-item.ts";

export type FeedItem = {
  projection: FeedItemProjection;
  artifact: FeedArtifact | null;
  error?: string;
};

export function projectionLabel(projection: FeedItemProjection): string {
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
    const published = b.projection.publishedAt.localeCompare(a.projection.publishedAt);
    return published !== 0 ? published : a.projection.feedItemId.localeCompare(b.projection.feedItemId);
  });
}

export async function hydrateFeedItems(
  projections: readonly FeedItemProjection[],
  loadArtifact: (artifactId: string) => Promise<FeedArtifact>,
): Promise<FeedItem[]> {
  const artifacts = new Map<string, Promise<FeedArtifact>>();
  return Promise.all(projections.map(async (projection): Promise<FeedItem> => {
    try {
      const artifactId = projection.target.artifactId;
      let artifactRequest = artifacts.get(artifactId);
      if (!artifactRequest) {
        artifactRequest = loadArtifact(artifactId);
        artifacts.set(artifactId, artifactRequest);
      }
      return { projection, artifact: await artifactRequest };
    } catch (error) {
      return {
        projection,
        artifact: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}
