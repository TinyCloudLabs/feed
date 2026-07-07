import { describe, expect, test } from "bun:test";
import { buildDataTrail, fileLeaf } from "./dataTrail.ts";
import type { FeedCard } from "./types.ts";

function card(overrides: Partial<FeedCard> = {}): FeedCard {
  return {
    id: "artifact-1",
    type: "clip",
    render_type: "video",
    slug: "proof-clip",
    headline: "Proof clip",
    body_md: "Body",
    quote: null,
    attribution: null,
    tags: ["smithers"],
    source_transcripts: ["/tmp/listen/alpha.md", "beta.md"],
    hero_image_key: "media/artifact-1/poster.png",
    audio_key: null,
    audio_mime: null,
    video_key: "media/artifact-1/video.mp4",
    video_mime: "video/mp4",
    video_url: null,
    audience: "internal",
    approval_status: "approved",
    platform: null,
    generation_model: "seedance-2.0",
    critic_pass: true,
    quotes_verified: true,
    generated_at: "2026-06-20T00:44:36.248Z",
    published_at: "2026-06-22T14:23:07.787Z",
    publisher_did: "did:pkh:eip155:1:0xAgent",
    schema_version: 1,
    raw: {
      quality: { notes: "full-media-smoke proof artifact" },
      source_quotes: [
        { quote: "Video generation is wired.", speaker: "Smithers", transcript: "/tmp/listen/alpha.md" },
        { quote: "   ", speaker: "Ignored", transcript: "ignored.md" },
        "bad-shape",
      ],
      producer: {
        pipeline: "artifactory-agent",
        run_id: "run-123",
        execution_source: "smithers-agent-run-staged",
        execution_source_label: "Smithers staged agent-run",
        execution_entrypoint: "bun run smithers:agent-run:staged",
        target_artifact_type: "clip",
        media_focus: "video",
        published_by_agent_at: "2026-06-22T14:23:07.000Z",
        delegation_cid: "bafy-delegation",
        delegation_expires_at: "2026-06-25T00:00:00.000Z",
        delegated_space: "tinycloud:pkh:eip155:1:0xUser:applications",
      },
    },
    ...overrides,
  };
}

describe("data trail", () => {
  test("keeps only useful source leaf names", () => {
    expect(fileLeaf("/tmp/listen/transcript.md")).toBe("transcript.md");
    expect(fileLeaf("plain.md")).toBe("plain.md");
  });

  test("summarizes sources, quotes, media, run, and delegation", () => {
    const trail = buildDataTrail(card());

    expect(trail.sources).toEqual(["alpha.md", "beta.md"]);
    expect(trail.quotes).toEqual([
      {
        quote: "Video generation is wired.",
        speaker: "Smithers",
        transcript: "/tmp/listen/alpha.md",
      },
    ]);
    expect(trail.notes).toBe("full-media-smoke proof artifact");
    expect(trail.mediaKeys).toEqual([
      "hero=media/artifact-1/poster.png",
      "video=media/artifact-1/video.mp4",
    ]);
    expect(trail.producer.run).toEqual([
      "artifactory-agent",
      "run=run-123",
      "source=Smithers staged agent-run",
      "entry=bun run smithers:agent-run:staged",
      "target=clip",
      "media=video",
      "agent_publish=2026-06-22T14:23:07.000Z",
    ]);
    expect(trail.producer.delegation).toEqual([
      "cid=bafy-delegation",
      "expires=2026-06-25T00:00:00.000Z",
      "space=tinycloud:pkh:eip155:1:0xUser:applications",
    ]);
    expect(trail.summaryBits).toEqual(["2 sources", "1 quote", "2 media", "run", "delegation"]);
  });

  test("accepts camelCase producer fields from older or alternate publishers", () => {
    const trail = buildDataTrail(
      card({
        raw: {
          producer: {
            pipeline: "artifactory-agent",
            runId: "run-camel",
            targetArtifactType: "article",
            mediaFocus: "balanced",
            publishedByAgentAt: "2026-06-22T14:23:29.000Z",
            delegationCid: "bafy-camel",
            delegationExpiresAt: "2026-06-25T00:00:00.000Z",
            delegatedSpace: "tinycloud:space",
          },
        },
      }),
    );

    expect(trail.producer.run).toContain("run=run-camel");
    expect(trail.producer.run).toContain("target=article");
    expect(trail.producer.delegation).toContain("cid=bafy-camel");
    expect(trail.summaryBits).toContain("delegation");
  });

  test("omits run and delegation markers when provenance is absent", () => {
    const trail = buildDataTrail(card({ raw: {}, source_transcripts: [], hero_image_key: null, video_key: null }));

    expect(trail.producer).toEqual({ run: [], delegation: [] });
    expect(trail.summaryBits).toEqual([]);
  });
});
