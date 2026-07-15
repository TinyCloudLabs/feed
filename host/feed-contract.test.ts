import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  feedItemIdForPost,
  FEED_POST_BODY_MAX_CHARS,
  postsFromArtifact,
  validateFeedItemProjection,
  validateFeedItemProjectionJoin,
  validateFeedTargetedInteractionEvent,
  type FeedItemProjection,
} from "../shared/feed-item.ts";

const NOW = "2026-07-11T12:00:00.000Z";

function projection(overrides: Partial<FeedItemProjection> = {}): FeedItemProjection {
  return {
    feedItemId: "artifact::insight",
    target: { kind: "post", artifactId: "artifact", postId: "insight" },
    rankScore: 0.8,
    disposition: "default",
    visibility: "ranked",
    freshnessLabel: "fresh",
    reasonCodes: ["recent"],
    packageId: "package",
    sourceFingerprint: "sha256:source",
    publishedAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("Feed-owned item and interaction contracts", () => {
  test("pins the canonical cross-repository fixtures and identity vector", () => {
    const fixture = (name: string) => readFileSync(new URL(`../shared/fixtures/${name}`, import.meta.url));
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const vectors = JSON.parse(fixture("feed-post-identity-vectors.json").toString()) as {
      contractVersion: string;
      vectors: Array<{ expected: { postId: string } }>;
    };

    expect(digest(fixture("rich-artifact.json"))).toBe("0d06420bb70e91c3a77ad9c71865c09cf0c4cde29b12b7691f67af47c15cb8b9");
    expect(digest(fixture("feed-post-identity-vectors.json"))).toBe("d2c169f3c65ff25448a784995c23d7ce934e4082504be2c3e46a393b5bd2a3e3");
    expect(vectors.contractVersion).toBe("feed.post.v1");
    expect(vectors.vectors[0]?.expected.postId).toBe("post:9088faedcc601db95f7945c289770623d36a25d7b1c5fbddf8b2723f3603665a");
  });

  test("accepts normative post and legacy preview identities", () => {
    expect(validateFeedItemProjection(projection()).ok).toBe(true);
    expect(validateFeedItemProjection(projection({
      feedItemId: "legacy:artifact",
      target: { kind: "artifact_preview", artifactId: "artifact" },
    })).ok).toBe(true);
    expect(feedItemIdForPost("artifact", "decision / one")).toBe("artifact::decision%20%2F%20one");
  });

  test("rejects forged identities, dangling post targets, and invalid joins", () => {
    expect(validateFeedItemProjection(projection({ feedItemId: "forged" }))).toMatchObject({
      ok: false,
      errors: ["feedItemId: does not match target identity"],
    });
    expect(validateFeedItemProjection(projection({
      feedItemId: "legacy:artifact",
      target: { kind: "artifact_preview", artifactId: "artifact", postId: "fake" } as never,
    })).ok).toBe(false);

    const artifact = {
      artifactId: "artifact",
      posts: [{
        postId: "other",
        postFingerprint: "sha256:other",
        kind: "insight",
        body: "Other",
        evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "s1", loc: "0" }],
        expansionTarget: { artifactId: "artifact" },
      }],
    } as never;
    expect(validateFeedItemProjectionJoin(projection(), artifact)).toMatchObject({
      ok: false,
      errors: ["target.postId: missing from hydrated artifact"],
    });
  });

  test("accepts each interaction target and rejects mixed targets or unknown signals", () => {
    const base = {
      eventId: "event",
      actorId: "did:reader",
      readerNonce: "nonce",
      signal: "helpful",
      createdAt: NOW,
    } as const;
    expect(validateFeedTargetedInteractionEvent({ ...base, target: { kind: "artifact", artifactId: "artifact" } }).ok).toBe(true);
    expect(validateFeedTargetedInteractionEvent({ ...base, target: { kind: "post", artifactId: "artifact", postId: "post" } }).ok).toBe(true);
    expect(validateFeedTargetedInteractionEvent({ ...base, target: { kind: "feed_item", feedItemId: "artifact::post" } }).ok).toBe(true);
    expect(validateFeedTargetedInteractionEvent({
      ...base,
      target: { kind: "feed_item", feedItemId: "item", artifactId: "smuggled" },
    }).ok).toBe(false);
    expect(validateFeedTargetedInteractionEvent({ ...base, signal: "execute", target: { kind: "artifact", artifactId: "artifact" } }).ok).toBe(false);
  });

  test("enforces explicit surface policy, derived release metadata, and deterministic post size", () => {
    const post = {
      postId: "post:one",
      postFingerprint: "sha256:one",
      kind: "insight",
      body: "Useful post",
      evidence: [{ kind: "located_source", evidenceId: "e1", sourceRefId: "s1", loc: "0" }],
      expansionTarget: { artifactId: "artifact" },
    };
    const artifact = { artifactId: "artifact", posts: [post] };
    expect(postsFromArtifact({ ...artifact, feedSurface: { mode: "none" } } as never)).toHaveLength(0);
    expect(postsFromArtifact({ ...artifact, feedSurface: { mode: "posts" } } as never)).toHaveLength(0);
    expect(postsFromArtifact({
      ...artifact,
      feedSurface: { mode: "posts" },
      derivedAccess: { releasePolicy: "private" },
    } as never)).toHaveLength(1);
    expect(postsFromArtifact({
      ...artifact,
      posts: [{ ...post, body: "x".repeat(FEED_POST_BODY_MAX_CHARS + 1) }],
      feedSurface: { mode: "posts" },
      derivedAccess: { releasePolicy: "private" },
    } as never)).toHaveLength(0);
  });
});
