import { describe, expect, test } from "bun:test";
import { bodyPreview, sortedFeed, type FeedItem } from "./feedModel.ts";

function item(id: string, rankScore: number, publishedAt: string): FeedItem {
  return {
    projection: {
      artifactId: id,
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
      ]).map((feedItem) => feedItem.projection.artifactId),
    ).toEqual(["top", "new", "old"]);
  });

  test("extracts readable artifact body previews", () => {
    expect(bodyPreview(null)).toContain("not been hydrated");
    expect(bodyPreview({ body: { markdown: "Hello" } } as never)).toBe("Hello");
    expect(bodyPreview({ body: "Plain" } as never)).toBe("Plain");
  });
});
