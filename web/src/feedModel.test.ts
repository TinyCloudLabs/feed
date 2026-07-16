import { describe, expect, test } from "bun:test";
import {
  bodyPreview,
  createLazyArtifactCache,
  feedItemAvailability,
  feedItemsForView,
  feedItemsFromProjections,
  hydrateFeedItems,
  projectionCanHydrate,
  projectedPost,
  readableFeedTime,
  readablePostKind,
  readableProvenance,
  sortedFeed,
  type FeedItem,
} from "./feedModel.ts";
import { artifactExpansionSection, artifactSectionText } from "../../shared/feed-item.ts";

function item(id: string, rankScore: number, publishedAt: string): FeedItem {
  return {
    projection: {
      feedItemId: `legacy:${id}`,
      target: { kind: "artifact_preview", artifactId: id },
      rankScore,
      disposition: "default",
      visibility: "ranked",
      freshnessLabel: "fresh",
      reasonCodes: [],
      packageId: "daily_digest",
      sourceFingerprint: `source:${id}`,
      publishedAt,
      updatedAt: publishedAt,
    },
    artifact: null,
  };
}

describe("Feed v1 model helpers", () => {
  test("sorts by rank and then recency", () => {
    expect(
      sortedFeed([
        item("old", 10, "2026-06-27T10:00:00.000Z"),
        item("new", 10, "2026-06-28T10:00:00.000Z"),
        item("top", 20, "2026-06-26T10:00:00.000Z"),
      ]).map((feedItem) => feedItem.projection.target.artifactId),
    ).toEqual(["top", "new", "old"]);
  });

  test("extracts readable artifact body previews", () => {
    expect(bodyPreview(null)).toContain("not been hydrated");
    expect(bodyPreview({ body: { markdown: "Hello" } } as never)).toBe("Hello");
    expect(bodyPreview({ body: "Plain" } as never)).toBe("Plain");
  });

  test("resolves a post expansion anchor inside the shared artifact", () => {
    const artifact = {
      body: {
        sections: [
          { sectionId: "first", text: "First section" },
          { sectionId: "decision", text: "The decision and its tradeoffs" },
        ],
      },
    } as never;
    expect(artifactSectionText(artifact, "decision")).toBe("The decision and its tradeoffs");
    expect(artifactSectionText(artifact, "missing")).toBeUndefined();
  });

  test("resolves a render-hinted section in a type-specific body and exposes its anchor", () => {
    const artifact = {
      artifactType: "decision_matrix",
      body: {
        analysis: {
          recommendation: { heading: "Recommendation", markdown: "Choose the reversible option." },
        },
      },
      renderHints: {
        sectionTargets: [{ sectionId: "recommendation", title: "Recommended path", bodyPath: "/analysis/recommendation" }],
      },
    } as never;

    expect(artifactExpansionSection(artifact, "recommendation")).toEqual({
      sectionId: "recommendation",
      title: "Recommended path",
      text: "Choose the reversible option.",
    });
  });

  test("hydrates two post projections through one shared artifact request", async () => {
    const first = item("shared-artifact", 0.9, "2026-06-28T10:00:00.000Z").projection;
    const second = {
      ...first,
      feedItemId: "shared-artifact::second",
      target: { kind: "post" as const, artifactId: "shared-artifact", postId: "second" },
      postBody: "A second post from the same artifact.",
    };
    const projections = [
      { ...first, feedItemId: "shared-artifact::first", target: { kind: "post" as const, artifactId: "shared-artifact", postId: "first" }, postBody: "The first post." },
      second,
    ];
    let calls = 0;
    const artifact = { artifactId: "shared-artifact", title: "Shared rich artifact" } as never;

    const hydrated = await hydrateFeedItems(projections, async () => {
      calls += 1;
      return artifact;
    });

    expect(calls).toBe(1);
    expect(hydrated).toHaveLength(2);
    expect(hydrated[0]?.projection.feedItemId).not.toBe(hydrated[1]?.projection.feedItemId);
    expect(hydrated[0]?.artifact).toBe(artifact);
    expect(hydrated[1]?.artifact).toBe(artifact);
  });

  test("only repair-only and broken-ref projections are excluded from hydration", async () => {
    const repairOnly = {
      ...item("repair-only", 0.9, "2026-06-28T10:00:00.000Z").projection,
      visibility: "repair_only" as const,
    };
    const brokenRef = {
      ...item("broken-ref", 0.85, "2026-06-28T09:30:00.000Z").projection,
      reasonCodes: ["broken_ref", "source_unavailable"],
    };
    const readableUnavailableSource = {
      ...item("unavailable", 0.8, "2026-06-28T09:00:00.000Z").projection,
      freshnessLabel: "source_unavailable" as const,
      reasonCodes: ["source_unavailable"],
    };
    let calls = 0;

    const hydrated = await hydrateFeedItems([repairOnly, brokenRef, readableUnavailableSource], async () => {
      calls += 1;
      return artifact();
    });

    expect(projectionCanHydrate(repairOnly)).toBe(false);
    expect(projectionCanHydrate(brokenRef)).toBe(false);
    expect(projectionCanHydrate(readableUnavailableSource)).toBe(true);
    expect(calls).toBe(1);
    expect(hydrated.slice(0, 2).every((entry) => entry.artifact === null)).toBe(true);
    expect(hydrated[2]?.artifact).not.toBeNull();
  });

  test("a cleaned projection with the same feed item identity becomes hydratable", () => {
    const quarantined = {
      ...item("repaired-in-place", 0.8, "2026-06-28T09:00:00.000Z").projection,
      visibility: "repair_only" as const,
      reasonCodes: ["broken_ref"],
    };
    const cleaned = { ...quarantined, visibility: "ranked" as const, reasonCodes: [] };

    expect(cleaned.feedItemId).toBe(quarantined.feedItemId);
    expect(projectionCanHydrate(quarantined)).toBe(false);
    expect(projectionCanHydrate(cleaned)).toBe(true);
  });

  test("builds an immediately renderable feed and filters for-you and saved views", () => {
    const defaultItem = item("default", 0.9, "2026-06-28T10:00:00.000Z");
    const savedItem = {
      ...item("saved", 0.8, "2026-06-28T09:00:00.000Z"),
      projection: { ...item("saved", 0.8, "2026-06-28T09:00:00.000Z").projection, disposition: "saved" as const },
    };
    const hiddenItem = {
      ...item("hidden", 0.7, "2026-06-28T08:00:00.000Z"),
      projection: { ...item("hidden", 0.7, "2026-06-28T08:00:00.000Z").projection, disposition: "hidden" as const },
    };
    const visibilityHiddenItem = {
      ...item("visibility-hidden", 0.6, "2026-06-28T07:00:00.000Z"),
      projection: { ...item("visibility-hidden", 0.6, "2026-06-28T07:00:00.000Z").projection, visibility: "hidden" as const },
    };
    const projected = feedItemsFromProjections([
      defaultItem.projection,
      savedItem.projection,
      hiddenItem.projection,
      visibilityHiddenItem.projection,
    ]);

    expect(projected.every((feedItem) => feedItem.artifact === null)).toBe(true);
    expect(feedItemsForView(projected, "for_you").map((feedItem) => feedItem.projection.target.artifactId)).toEqual([
      "default",
      "saved",
    ]);
    expect(feedItemsForView(projected, "saved").map((feedItem) => feedItem.projection.target.artifactId)).toEqual(["saved"]);
  });

  test("matches a projected post and formats generic kind and time labels", () => {
    const projection = {
      ...item("artifact", 0.9, "2026-07-14T10:30:00.000Z").projection,
      feedItemId: "artifact::post-1",
      target: { kind: "post" as const, artifactId: "artifact", postId: "post-1" },
    };
    const feedItem = {
      projection,
      artifact: artifact({
        posts: [{
          postId: "post-1",
          postFingerprint: "sha256:post-1",
          kind: "decision_memo",
          body: "Choose the reversible option.",
          evidence: [],
          expansionTarget: { artifactId: "artifact" },
        }],
      }),
    };

    expect(projectedPost(feedItem)?.body).toBe("Choose the reversible option.");
    expect(readablePostKind(feedItem)).toBe("Decision memo");
    expect(readableFeedTime(projection.publishedAt, new Date("2026-07-14T12:00:00.000Z"))).toBe("1h ago");
    expect(readableFeedTime("not-a-date", new Date("2026-07-14T12:00:00.000Z"))).toBe("Recently");
  });

  test("reports explicit availability states with revoked authority taking precedence", () => {
    const base = item("availability", 0.9, "2026-07-14T10:30:00.000Z");
    expect(feedItemAvailability(base)).toBe("available");
    expect(feedItemAvailability({ ...base, error: "424" })).toBe("artifact_unavailable");
    expect(feedItemAvailability({
      ...base,
      projection: { ...base.projection, freshnessLabel: "source_unavailable" },
      error: "424",
    })).toBe("source_unavailable");
    expect(feedItemAvailability({
      ...base,
      projection: { ...base.projection, reasonCodes: ["source_revoked", "broken_ref"] },
      error: "424",
    })).toBe("source_revoked");
    expect(feedItemAvailability({
      ...base,
      projection: { ...base.projection, reasonCodes: ["source_unavailable", "broken_ref"] },
    })).toBe("artifact_unavailable");
  });

  test("summarizes provenance without exposing raw identifiers", () => {
    const base = item("private-artifact-id", 0.9, "2026-07-14T10:30:00.000Z");
    const summary = readableProvenance({
      ...base,
      artifact: artifact({
        sourceRefs: [sourceRef("one"), sourceRef("two")],
      }),
    });

    expect(summary).toEqual({
      madeBy: "Feed",
      sourceSummary: "2 Listen conversations",
      freshnessSummary: "Fresh",
      workflowSummary: "Turns allowed conversations into a private brief.",
    });
    expect(JSON.stringify(summary)).not.toContain("private-artifact-id");
    expect(JSON.stringify(summary)).not.toContain("sha256:");
    expect(JSON.stringify(summary)).not.toContain("private-package");

    const genericSummary = readableProvenance({
      ...base,
      artifact: artifact({
        sourceRefs: [{ ...sourceRef("one"), sourceKind: "uploaded_document" }],
      }),
    });
    expect(genericSummary.sourceSummary).toBe("1 Uploaded document");
  });

  test("lazy artifact cache shares concurrent loads, supports peek, and retries failures", async () => {
    let calls = 0;
    let fail = true;
    const loaded = artifact();
    const cache = createLazyArtifactCache(async () => {
      calls += 1;
      if (fail) throw new Error("temporarily unavailable");
      return loaded;
    });
    const feedItem = item("artifact", 0.9, "2026-07-14T10:30:00.000Z");

    expect(cache.peek("artifact")).toBeUndefined();
    expect((await cache.hydrate(feedItem)).error).toBe("temporarily unavailable");
    fail = false;
    const [first, second] = await Promise.all([cache.load("artifact"), cache.load("artifact")]);

    expect(calls).toBe(2);
    expect(first).toBe(loaded);
    expect(second).toBe(loaded);
    expect(cache.peek("artifact")).toBe(loaded);
    expect((await cache.hydrate(feedItem)).artifact).toBe(loaded);
    expect(calls).toBe(2);
  });
});

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "feed.artifact.v1",
    artifactId: "artifact",
    artifactType: "daily_brief",
    renderShape: "longform",
    title: "Private brief",
    body: { text: "Complete artifact" },
    sourceRefs: [sourceRef("one")],
    producedBy: {
      packageId: "private-package",
      packageVersion: "1.0.0",
      packageDigest: "sha256:package",
      runId: "private-run",
      runtimeClass: "feed_hosted",
      providerClass: "first_party",
      credentialOwner: "feed_hosted",
      egressClass: "model_provider",
      disclosure: {
        userCopy: "Turns allowed conversations into a private brief.",
        credentialOwner: "feed_hosted",
        providerClass: "first_party",
        egressClass: "model_provider",
      },
    },
    freshness: { label: "fresh", asOf: "2026-07-14T10:30:00.000Z" },
    idempotency: {
      sourceFingerprint: "sha256:source",
      artifactFingerprint: "sha256:artifact",
      dedupeKey: "sha256:dedupe",
    },
    storage: { docKey: "private/doc.json" },
    createdAt: "2026-07-14T10:30:00.000Z",
    updatedAt: "2026-07-14T10:30:00.000Z",
    ...overrides,
  } as never;
}

function sourceRef(id: string) {
  return {
    sourceRefId: `source-${id}`,
    sourceKind: "listen_conversation",
    sourceId: `conversation-${id}`,
    observedPath: "sql_transcript_text",
    observedHash: `sha256:${id}`,
    observedAt: "2026-07-14T10:00:00.000Z",
  };
}
