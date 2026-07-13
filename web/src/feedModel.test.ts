import { describe, expect, test } from "bun:test";
import { bodyPreview, hydrateFeedItems, sortedFeed, type FeedItem } from "./feedModel.ts";
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
});
