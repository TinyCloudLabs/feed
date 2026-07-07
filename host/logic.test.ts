import { describe, expect, test } from "bun:test";
import type {
  FeedPreferenceProfileRecord,
  FeedPreferenceValue,
  FeedProjectionState,
  FeedReconcileArtifact,
} from "./logic.ts";
import {
  mergeFeedPreferences,
  rankFeedProjections,
  reconcileFeedProjections,
  summarizeFeedbackEvents,
} from "./logic.ts";

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
    expect(defaultRank.map((row) => row.artifactId)).toEqual(["alpha", "beta"]);

    const feedbackRank = rankFeedProjections({
      items: [
        alpha,
        {
          ...beta,
          disposition: "saved",
        },
      ],
      feedbackByArtifact: summarizeFeedbackEvents([
        { artifactId: "beta", signal: "save", createdAt: "2026-06-29T12:05:00.000Z" },
      ]),
      now: NOW,
    });
    expect(feedbackRank.map((row) => row.artifactId)).toEqual(["beta", "alpha"]);

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
    expect(preferenceRank.map((row) => row.artifactId)).toEqual(["beta", "alpha"]);
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

    expect(plan.desired.map((row) => row.artifactId).sort()).toEqual(["alpha", "beta"]);
    expect(plan.upserts.map((row) => row.artifactId).sort()).toEqual(["alpha", "beta"]);
    expect(plan.deletions).toEqual(["gamma"]);
    expect(plan.desired.find((row) => row.artifactId === "alpha")?.sourceFingerprint).toBe("sha256:alpha-source");
    expect(plan.desired.find((row) => row.artifactId === "alpha")?.disposition).toBe("hidden");
    expect(plan.desired.find((row) => row.artifactId === "beta")?.visibility).toBe("ranked");

    const applied = new Map(current.map((row) => [row.artifactId, row] as const));
    for (const artifactId of plan.deletions) applied.delete(artifactId);
    for (const row of plan.upserts) applied.set(row.artifactId, row);

    const rerun = reconcileFeedProjections({
      artifacts,
      projections: [...applied.values()],
      now: NOW,
    });

    expect(rerun.upserts).toHaveLength(0);
    expect(rerun.deletions).toHaveLength(0);
    expect(rerun.desired.map((row) => row.artifactId).sort()).toEqual(["alpha", "beta"]);
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
});

function projection(overrides: Partial<FeedProjectionState> & Pick<FeedProjectionState, "artifactId" | "packageId" | "sourceFingerprint" | "publishedAt" | "updatedAt" | "rankScore">): FeedProjectionState {
  return {
    artifactId: overrides.artifactId,
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
    ...overrides,
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
