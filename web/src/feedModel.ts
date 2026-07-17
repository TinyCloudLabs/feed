import type { FeedArtifact } from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import { postsFromArtifact, type FeedItemProjection, type FeedPost } from "../../shared/feed-item.ts";

export type FeedItem = {
  projection: FeedItemProjection;
  artifact: FeedArtifact | null;
  error?: string;
};

export type FeedView = "for_you" | "saved";

export type FeedItemAvailability =
  | "available"
  | "source_revoked"
  | "source_unavailable"
  | "artifact_unavailable";

export type ReadableProvenance = {
  madeBy: "Feed";
  sourceSummary: string;
  freshnessSummary: string;
  workflowSummary?: string;
};

export type FeedKickerInput = {
  artifact: FeedArtifact | null;
  post?: FeedPost;
  publishedAt: string;
  kind?: string;
  now?: Date;
};

export type LazyArtifactCache = {
  peek: (artifactId: string) => FeedArtifact | undefined;
  load: (artifactId: string) => Promise<FeedArtifact>;
  hydrate: (item: FeedItem) => Promise<FeedItem>;
  clear: () => void;
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

export function feedItemsFromProjections(projections: readonly FeedItemProjection[]): FeedItem[] {
  return projections.map((projection) => ({ projection, artifact: null }));
}

export function feedItemsForView(items: readonly FeedItem[], view: FeedView): FeedItem[] {
  return items.filter((item) => {
    if (item.projection.disposition === "hidden" || item.projection.visibility === "hidden") return false;
    return view === "for_you" || item.projection.disposition === "saved";
  });
}

export function projectedPost(item: FeedItem): FeedPost | undefined {
  if (!item.artifact || item.projection.target.kind !== "post") return undefined;
  const postId = item.projection.target.postId;
  return postsFromArtifact(item.artifact).find((post) => post.postId === postId);
}

export function readablePostKind(item: FeedItem): string {
  return humanizeLabel(projectedPost(item)?.kind ?? item.artifact?.artifactType ?? "feed_post");
}

export function readableFeedTime(publishedAt: string, now: Date = new Date()): string {
  const timestamp = Date.parse(publishedAt);
  if (!Number.isFinite(timestamp)) return "Recently";
  const elapsedMinutes = Math.max(0, Math.floor((now.getTime() - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "Just now";
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays}d ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(timestamp));
}

export function feedKickerSegments({
  artifact,
  post,
  publishedAt,
  kind,
  now = new Date(),
}: FeedKickerInput): string[] {
  const sourceCount = artifact
    ? post
      ? new Set(post.evidence.flatMap((entry) => "sourceRefId" in entry ? [entry.sourceRefId] : [])).size
      : artifact.sourceRefs.length
    : 0;
  return [
    humanizeLabel(kind ?? post?.kind ?? artifact?.artifactType ?? "feed_post"),
    ...(sourceCount > 0
      ? [`${sourceCount} conversation${sourceCount === 1 ? "" : "s"}`]
      : []),
    readableFeedTime(publishedAt, now),
  ];
}

export function feedItemAvailability(item: FeedItem): FeedItemAvailability {
  const freshness = item.artifact?.freshness.label ?? item.projection.freshnessLabel;
  if (freshness === "source_revoked" || item.projection.reasonCodes.includes("source_revoked")) {
    return "source_revoked";
  }
  if (freshness === "source_unavailable") return "source_unavailable";
  if (item.error || item.projection.visibility === "repair_only" || item.projection.reasonCodes.includes("broken_ref")) {
    return "artifact_unavailable";
  }
  if (item.projection.reasonCodes.includes("source_unavailable")) return "source_unavailable";
  return "available";
}

export function readableProvenance(item: FeedItem): ReadableProvenance {
  const artifact = item.artifact;
  return {
    madeBy: "Feed",
    sourceSummary: artifact
      ? readableSourceSummary(artifact.sourceRefs)
      : "Source details are available when the artifact opens.",
    freshnessSummary: humanizeLabel(artifact?.freshness.label ?? item.projection.freshnessLabel),
    ...(artifact?.producedBy.disclosure.userCopy
      ? { workflowSummary: artifact.producedBy.disclosure.userCopy }
      : {}),
  };
}

export function createLazyArtifactCache(
  loadArtifact: (artifactId: string) => Promise<FeedArtifact>,
): LazyArtifactCache {
  const resolved = new Map<string, FeedArtifact>();
  const pending = new Map<string, Promise<FeedArtifact>>();
  let generation = 0;

  const load = (artifactId: string): Promise<FeedArtifact> => {
    const artifact = resolved.get(artifactId);
    if (artifact) return Promise.resolve(artifact);
    const existing = pending.get(artifactId);
    if (existing) return existing;
    const requestGeneration = generation;
    const request = Promise.resolve()
      .then(() => loadArtifact(artifactId))
      .then((loaded) => {
        if (requestGeneration === generation) {
          resolved.set(artifactId, loaded);
          pending.delete(artifactId);
        }
        return loaded;
      })
      .catch((error: unknown) => {
        if (requestGeneration === generation) pending.delete(artifactId);
        throw error;
      });
    pending.set(artifactId, request);
    return request;
  };

  return {
    peek: (artifactId) => resolved.get(artifactId),
    load,
    async hydrate(item) {
      try {
        return { projection: item.projection, artifact: await load(item.projection.target.artifactId) };
      } catch (error) {
        return {
          projection: item.projection,
          artifact: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    clear() {
      generation += 1;
      resolved.clear();
      pending.clear();
    },
  };
}

export async function hydrateFeedItems(
  projections: readonly FeedItemProjection[],
  loadArtifact: (artifactId: string) => Promise<FeedArtifact>,
): Promise<FeedItem[]> {
  const cache = createLazyArtifactCache(loadArtifact);
  return Promise.all(feedItemsFromProjections(projections).map((item) => cache.hydrate(item)));
}

function humanizeLabel(value: string): string {
  const normalized = value.trim().replaceAll(/[_-]+/g, " ").replaceAll(/\s+/g, " ");
  if (!normalized) return "Feed post";
  return normalized[0]!.toUpperCase() + normalized.slice(1).toLowerCase();
}

export function readableSourceSummary(sourceRefs: FeedArtifact["sourceRefs"]): string {
  const count = sourceRefs.length;
  if (count === 0) return "No source details available";
  if (sourceRefs.every((source) => source.sourceKind === "listen_conversation")) {
    return `${count} Listen conversation${count === 1 ? "" : "s"}`;
  }
  if (count === 1) return `1 ${humanizeLabel(sourceRefs[0]!.sourceKind)}`;
  return `${count} authorized sources`;
}
