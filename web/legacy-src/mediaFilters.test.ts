import { describe, expect, test } from "bun:test";
import { filterByMedia, mediaFilterCounts } from "./mediaFilters.ts";

const cards = [
  { id: "plain", hero_image_key: null, audio_key: null, video_key: null },
  { id: "image", hero_image_key: "media/image/hero.png", audio_key: null, video_key: null },
  { id: "audio", hero_image_key: null, audio_key: "media/audio/episode.m4a", video_key: null },
  { id: "video", hero_image_key: "media/video/poster.png", audio_key: null, video_key: "media/video/clip.mp4" },
];

describe("media filters", () => {
  test("counts media-bearing cards by kind", () => {
    expect(mediaFilterCounts(cards)).toEqual({
      all: 4,
      video: 1,
      audio: 1,
      image: 2,
    });
  });

  test("filters cards by explicit media kind", () => {
    expect(filterByMedia(cards, "all").map((card) => card.id)).toEqual(["plain", "image", "audio", "video"]);
    expect(filterByMedia(cards, "video").map((card) => card.id)).toEqual(["video"]);
    expect(filterByMedia(cards, "audio").map((card) => card.id)).toEqual(["audio"]);
    expect(filterByMedia(cards, "image").map((card) => card.id)).toEqual(["image", "video"]);
  });
});
