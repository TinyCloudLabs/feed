import { describe, expect, test } from "bun:test";
import { composeFeed, type CompositionCard } from "./feedComposition.ts";

function card(
  id: string,
  type: string,
  source = "shared.md",
  runId = "run-a",
  media: Partial<Pick<CompositionCard, "hero_image_key" | "audio_key" | "video_key">> = {},
): CompositionCard {
  return {
    id,
    type,
    render_type: type === "social-post" ? "tweet" : type === "clip" ? "video" : "article",
    source_transcripts: [source],
    hero_image_key: media.hero_image_key ?? null,
    audio_key: media.audio_key ?? null,
    video_key: media.video_key ?? null,
    raw: { producer: { run_id: runId } },
  };
}

describe("composeFeed", () => {
  test("keeps the newest artifact as the first card", () => {
    const ordered = composeFeed([
      card("newest", "article"),
      card("second", "article"),
      card("third", "podcast", "other.md"),
    ]);

    expect(ordered[0]?.id).toBe("newest");
  });

  test("mixes artifact types when a nearby fresh alternative exists", () => {
    const ordered = composeFeed([
      card("a1", "article", "a.md"),
      card("a2", "article", "b.md"),
      card("a3", "article", "c.md"),
      card("p1", "podcast", "d.md", "run-b", { audio_key: "media/p1/audio.m4a.b64" }),
      card("d1", "digest", "e.md"),
    ]);

    expect(ordered.map((c) => c.id).slice(0, 4)).toEqual(["a1", "p1", "a2", "d1"]);
  });

  test("avoids letting one source transcript monopolize the top of the feed", () => {
    const ordered = composeFeed([
      card("a1", "article", "same.md"),
      card("p1", "podcast", "same.md"),
      card("d1", "digest", "other.md"),
      card("h1", "insight-card", "same.md"),
    ]);

    expect(ordered.map((c) => c.id).slice(0, 3)).toEqual(["a1", "d1", "p1"]);
  });

  test("returns a stable limited subset without dropping or duplicating ids", () => {
    const ordered = composeFeed(
      [
        card("a1", "article", "a.md"),
        card("p1", "podcast", "b.md"),
        card("d1", "digest", "c.md"),
        card("h1", "insight-card", "d.md"),
      ],
      3,
    );

    expect(ordered).toHaveLength(3);
    expect(new Set(ordered.map((c) => c.id)).size).toBe(3);
    expect(ordered.every((c) => ["a1", "p1", "d1", "h1"].includes(c.id))).toBe(true);
  });
});
