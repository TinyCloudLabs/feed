import { describe, expect, test } from "bun:test";
import type {
  FeedPreferenceProfileRecord,
  FeedPreferenceValue,
  FeedProjectionState,
  FeedReconcileArtifact,
} from "./logic.ts";
import {
  buildFeedEvents,
  filterFeedEventsAfterId,
  mergeFeedPreferences,
  rankFeedProjections,
  reconcileFeedProjections,
  summarizeFeedbackEvents,
} from "./logic.ts";
import { feedItemIdForPost, type FeedPost } from "../shared/feed-item.ts";

const NOW = new Date("2026-07-02T00:00:00.000Z");

describe("Feed ranking and reconciliation logic", () => {
  test("ranking changes when feedback and preferences change", () => {
    const alpha = projection({
      artifactId: "alpha",
      packageId: "alpha-package",
      publishedAt: "2026-06-29T12:01:00.000Z",
      rankScore: 0.58,
    });
    const beta = projection({
      artifactId: "beta",
      packageId: "beta-package",
      publishedAt: "2026-06-29T12:00:00.000Z",
      rankScore: 0.57,
    });

    const defaultRank = rankFeedProjections({
      items: [alpha, beta],
      now: NOW,
    });
    expect(defaultRank.map(artifactId)).toEqual(["alpha", "beta"]);

    const feedbackRank = rankFeedProjections({
      items: [
        alpha,
        {
          ...beta,
          disposition: "saved",
        },
      ],
      feedbackByArtifact: summarizeFeedbackEvents([
        { target: { kind: "artifact", artifactId: "beta" }, signal: "save", createdAt: "2026-06-29T12:05:00.000Z" },
      ]),
      now: NOW,
    });
    expect(feedbackRank.map(artifactId)).toEqual(["beta", "alpha"]);

    const preferenceRank = rankFeedProjections({
      items: [alpha, beta],
      preferences: mergeFeedPreferences([
        preferenceRecord("presentation", {
          packagePriority: {
            "beta-package": 5,
          },
        }),
      ]),
      now: NOW,
    });
    expect(preferenceRank.map(artifactId)).toEqual(["beta", "alpha"]);
  });

  test("reconciliation restores missing rows, corrects stale rows, and is stable on rerun", () => {
    const artifacts = [
      reconcileArtifact({
        artifactId: "alpha",
        packageId: "alpha-package",
        publishedAt: "2026-06-29T12:01:00.000Z",
        updatedAt: "2026-06-29T12:01:00.000Z",
        sourceFingerprint: "sha256:alpha-source",
        docMissing: false,
      }),
      reconcileArtifact({
        artifactId: "beta",
        packageId: "beta-package",
        publishedAt: "2026-06-29T12:00:00.000Z",
        updatedAt: "2026-06-29T12:00:00.000Z",
        sourceFingerprint: "sha256:beta-source",
        docMissing: false,
      }),
    ];
    const staleAlpha = projection({
      artifactId: "alpha",
      packageId: "alpha-package",
      sourceFingerprint: "sha256:stale-source",
      publishedAt: "2026-06-29T12:01:00.000Z",
      updatedAt: "2026-06-29T12:01:00.000Z",
      rankScore: 0.12,
      disposition: "hidden",
      visibility: "hidden",
      reasonCodes: ["stale", "broken_ref"],
      docMissing: true,
    });
    const staleGamma = projection({
      artifactId: "gamma",
      packageId: "gamma-package",
      sourceFingerprint: "sha256:gamma-source",
      publishedAt: "2026-06-29T11:59:00.000Z",
      updatedAt: "2026-06-29T11:59:00.000Z",
      rankScore: 0.22,
      disposition: "default",
      visibility: "ranked",
      reasonCodes: ["orphaned"],
      docMissing: false,
    });

    const current = [staleAlpha, staleGamma];
    const plan = reconcileFeedProjections({
      artifacts,
      projections: current,
      now: NOW,
    });

    expect(plan.desired.map(artifactId).sort()).toEqual(["alpha", "beta"]);
    expect(plan.upserts.map(artifactId).sort()).toEqual(["alpha", "beta"]);
    expect(plan.deletions).toEqual(["legacy:gamma"]);
    expect(plan.desired.find((row) => artifactId(row) === "alpha")?.sourceFingerprint).toBe("sha256:alpha-source");
    expect(plan.desired.find((row) => artifactId(row) === "alpha")?.disposition).toBe("hidden");
    expect(plan.desired.find((row) => artifactId(row) === "beta")?.visibility).toBe("ranked");

    const applied = new Map(current.map((row) => [row.feedItemId, row] as const));
    for (const feedItemId of plan.deletions) applied.delete(feedItemId);
    for (const row of plan.upserts) applied.set(row.feedItemId, row);

    const rerun = reconcileFeedProjections({
      artifacts,
      projections: [...applied.values()],
      now: NOW,
    });

    expect(rerun.upserts).toHaveLength(0);
    expect(rerun.deletions).toHaveLength(0);
    expect(rerun.desired.map(artifactId).sort()).toEqual(["alpha", "beta"]);
  });

  test("reconciliation clears repair_only when the artifact doc is repaired", () => {
    const artifacts = [
      reconcileArtifact({
        artifactId: "alpha",
        packageId: "alpha-package",
        publishedAt: "2026-06-29T12:01:00.000Z",
        updatedAt: "2026-06-29T12:02:00.000Z",
        sourceFingerprint: "sha256:alpha-source",
        docMissing: false,
      }),
    ];
    const current = [
      projection({
        artifactId: "alpha",
        packageId: "alpha-package",
        sourceFingerprint: "sha256:alpha-source",
        publishedAt: "2026-06-29T12:01:00.000Z",
        updatedAt: "2026-06-29T12:01:00.000Z",
        rankScore: 0.12,
        visibility: "repair_only",
        reasonCodes: ["fixture", "broken_ref", "source_unavailable"],
        docMissing: true,
      }),
    ];

    const plan = reconcileFeedProjections({
      artifacts,
      projections: current,
      now: NOW,
    });

    expect(plan.upserts).toHaveLength(1);
    expect(plan.upserts[0].visibility).toBe("ranked");
    expect(plan.upserts[0].reasonCodes).not.toContain("broken_ref");
    expect(plan.upserts[0].reasonCodes).not.toContain("source_unavailable");
  });

  test("reconciliation never replaces a newer projection with stale artifact state", () => {
    const current = projection({
      artifactId: "alpha",
      packageId: "new-package",
      sourceFingerprint: "sha256:new-source",
      publishedAt: "2026-06-29T12:00:00.000Z",
      updatedAt: "2026-06-29T12:05:00.000Z",
      rankScore: 0.77,
      postBody: "Newer rendered state",
    });
    const staleArtifact = reconcileArtifact({
      artifactId: "alpha",
      packageId: "stale-package",
      sourceFingerprint: "sha256:stale-source",
      publishedAt: "2026-06-29T12:00:00.000Z",
      updatedAt: "2026-06-29T12:04:00.000Z",
    });

    const plan = reconcileFeedProjections({ artifacts: [staleArtifact], projections: [current], now: NOW });

    expect(plan.desired).toEqual([current]);
    expect(plan.upserts).toHaveLength(0);
    expect(plan.desired[0]?.updatedAt).toBe("2026-06-29T12:05:00.000Z");
    expect(plan.desired[0]?.sourceFingerprint).toBe("sha256:new-source");
  });

  test("a stale artifact with fewer posts cannot delete a newer unmatched post", () => {
    const current = reconcileFeedProjections({ artifacts: [multiPostArtifact("2026-06-29T12:05:00.000Z")], projections: [], now: NOW }).desired;
    const stale = {
      ...multiPostArtifact("2026-06-29T12:04:00.000Z"),
      posts: [post("first", "Stale first insight", "section-one", "multi")],
    };

    const plan = reconcileFeedProjections({ artifacts: [stale], projections: current, now: NOW });

    expect(plan.deletions).toHaveLength(0);
    expect(plan.upserts).toHaveLength(0);
    expect(plan.desired.map((row) => row.feedItemId).sort()).toEqual(current.map((row) => row.feedItemId).sort());
  });

  test("a stale none surface cannot delete newer projections", () => {
    const current = reconcileFeedProjections({ artifacts: [multiPostArtifact("2026-06-29T12:05:00.000Z")], projections: [], now: NOW }).desired;
    const staleNone = { ...multiPostArtifact("2026-06-29T12:04:00.000Z"), surfaceMode: "none" as const };

    const plan = reconcileFeedProjections({ artifacts: [staleNone], projections: current, now: NOW });

    expect(plan.deletions).toHaveLength(0);
    expect(plan.desired).toEqual(current);
  });

  test("a newer authoritative artifact removes an obsolete post", () => {
    const current = reconcileFeedProjections({ artifacts: [multiPostArtifact("2026-06-29T12:05:00.000Z")], projections: [], now: NOW }).desired;
    const newer = {
      ...multiPostArtifact("2026-06-29T12:06:00.000Z"),
      posts: [post("first", "Authoritative first insight", "section-one", "multi")],
    };

    const plan = reconcileFeedProjections({ artifacts: [newer], projections: current, now: NOW });

    expect(plan.deletions).toEqual([feedItemIdForPost("multi", "second")]);
    expect(plan.desired.some((row) => row.feedItemId === feedItemIdForPost("multi", "second"))).toBe(false);
    expect(plan.desired.some((row) => row.feedItemId === feedItemIdForPost("multi", "first"))).toBe(true);
  });

  test("projects two stable post identities from one artifact while preserving legacy artifacts", () => {
    const artifact = reconcileArtifact({
      artifactId: "multi",
      packageId: "insight-package",
      sourceFingerprint: "sha256:multi-source",
      publishedAt: "2026-06-29T12:01:00.000Z",
      updatedAt: "2026-06-29T12:01:00.000Z",
      posts: [
        post("first", "First insight", "section-one", "multi"),
        post("second", "Second insight", "section-two", "multi"),
      ],
    });

    const first = reconcileFeedProjections({ artifacts: [artifact], projections: [], now: NOW });
    expect(first.desired).toHaveLength(3);
    expect(first.desired.filter((item) => item.target.kind === "post").map((item) => item.feedItemId)).toEqual([
      feedItemIdForPost("multi", "first"),
      feedItemIdForPost("multi", "second"),
    ]);
    expect(first.desired.every((item) => item.target.artifactId === "multi")).toBe(true);
    expect(first.desired.filter((item) => item.target.kind === "post").map((item) => item.sectionRef)).toEqual(["section-one", "section-two"]);

    const rerun = reconcileFeedProjections({ artifacts: [artifact], projections: first.desired, now: NOW });
    expect(rerun.upserts).toHaveLength(0);
    expect(rerun.deletions).toHaveLength(0);

    const legacy = reconcileFeedProjections({
      artifacts: [{ ...artifact, artifactId: "legacy-artifact", posts: [] }],
      projections: [],
      now: NOW,
    });
    expect(legacy.desired.map((item) => item.feedItemId)).toEqual(["legacy:legacy-artifact"]);

    const noSurface = reconcileFeedProjections({
      artifacts: [{ ...artifact, artifactId: "silent-artifact", surfaceMode: "none" }],
      projections: [],
      now: NOW,
    });
    expect(noSurface.desired).toHaveLength(0);
  });

  test("targets feedback to one post and caps a single artifact in composition", () => {
    const items = Array.from({ length: 6 }, (_, index) => projection({
      feedItemId: `artifact::${index}`,
      artifactId: "artifact",
      target: { kind: "post", artifactId: "artifact", postId: String(index) },
      packageId: "package",
      sourceFingerprint: "sha256:shared",
      publishedAt: `2026-06-29T12:0${index}:00.000Z`,
      updatedAt: `2026-06-29T12:0${index}:00.000Z`,
      rankScore: 0.5,
    }));
    const feedback = summarizeFeedbackEvents([
      { target: { kind: "feed_item", feedItemId: "artifact::0" }, signal: "helpful", createdAt: NOW.toISOString() },
    ]);
    const ranked = rankFeedProjections({ items, feedbackByArtifact: feedback, now: NOW });

    expect(ranked).toHaveLength(4);
    expect(ranked[0]?.feedItemId).toBe("artifact::0");
    expect(feedback.has("feed_item:artifact::0")).toBe(true);
    expect(feedback.has("artifact:artifact")).toBe(false);
    expect(ranked.find((item) => item.feedItemId === "artifact::0")?.reasonCodes).toContain("helpful_signal");
    expect(ranked.find((item) => item.feedItemId !== "artifact::0")?.reasonCodes).not.toContain("helpful_signal");
  });

  test("SSE resume replays reordered snapshots instead of dropping backfilled projections", () => {
    const initial = buildFeedEvents({
      projections: [
        projection({
          artifactId: "alpha",
          packageId: "alpha-package",
          publishedAt: "2026-06-29T12:00:00.000Z",
          updatedAt: "2026-06-29T12:00:00.000Z",
          rankScore: 0.58,
        }),
      ],
    });

    const current = buildFeedEvents({
      projections: [
        projection({
          artifactId: "alpha",
          packageId: "alpha-package",
          publishedAt: "2026-06-29T12:00:00.000Z",
          updatedAt: "2026-06-29T12:00:00.000Z",
          rankScore: 0.58,
        }),
        projection({
          artifactId: "beta",
          packageId: "beta-package",
          publishedAt: "2026-06-29T11:59:00.000Z",
          updatedAt: "2026-06-29T11:59:00.000Z",
          rankScore: 0.55,
        }),
      ],
    });

    const cursor = initial.at(-1)?.id ?? "";
    const resumed = filterFeedEventsAfterId(current, cursor);

    expect(resumed.map((event) => event.id)).not.toContain(cursor);
    expect(resumed.some((event) => event.id.includes("projection:legacy:beta:"))).toBe(true);
    expect(resumed).toHaveLength(current.length);
  });
});

function projection(overrides: Partial<FeedProjectionState> & { artifactId: string } & Pick<FeedProjectionState, "packageId" | "sourceFingerprint" | "publishedAt" | "updatedAt" | "rankScore">): FeedProjectionState {
  const { artifactId, ...stateOverrides } = overrides;
  return {
    feedItemId: overrides.feedItemId ?? `legacy:${artifactId}`,
    target: overrides.target ?? { kind: "artifact_preview", artifactId },
    artifactType: "insight_card",
    packageId: overrides.packageId,
    sourceFingerprint: overrides.sourceFingerprint,
    publishedAt: overrides.publishedAt,
    updatedAt: overrides.updatedAt,
    freshnessLabel: "fresh",
    disposition: "default",
    visibility: "ranked",
    reasonCodes: ["fixture"],
    rankScore: overrides.rankScore,
    docMissing: false,
    ...stateOverrides,
  };
}

function reconcileArtifact(
  overrides: Partial<FeedReconcileArtifact> & Pick<FeedReconcileArtifact, "artifactId" | "packageId" | "sourceFingerprint" | "publishedAt" | "updatedAt">,
): FeedReconcileArtifact {
  return {
    artifactId: overrides.artifactId,
    artifactType: "insight_card",
    packageId: overrides.packageId,
    sourceFingerprint: overrides.sourceFingerprint,
    publishedAt: overrides.publishedAt,
    updatedAt: overrides.updatedAt,
    freshnessLabel: "fresh",
    docMissing: false,
    ...overrides,
  };
}

function post(postId: string, body: string, anchor: string, artifactId: string): FeedPost {
  return {
    postId,
    postFingerprint: `sha256:${postId}`,
    kind: "insight",
    body,
    evidence: [{ kind: "located_source", evidenceId: "source", sourceRefId: "source", loc: "0" }],
    expansionTarget: { artifactId, sectionId: anchor },
  };
}

function multiPostArtifact(updatedAt: string): FeedReconcileArtifact {
  return reconcileArtifact({
    artifactId: "multi",
    packageId: "insight-package",
    sourceFingerprint: "sha256:multi-source",
    publishedAt: "2026-06-29T12:01:00.000Z",
    updatedAt,
    posts: [
      post("first", "First insight", "section-one", "multi"),
      post("second", "Second insight", "section-two", "multi"),
    ],
  });
}

function artifactId(row: FeedProjectionState): string {
  return row.target.artifactId;
}

function preferenceRecord(scope: string, value: FeedPreferenceValue): FeedPreferenceProfileRecord {
  return {
    profileId: `did:reader:${scope}`,
    actorId: "did:reader",
    scope,
    value,
    version: 1,
    updatedAt: "2026-06-29T12:00:00.000Z",
  };
}
