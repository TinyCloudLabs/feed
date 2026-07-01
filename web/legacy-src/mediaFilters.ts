import type { FeedCard } from "./types.ts";

export const MEDIA_FILTERS = ["all", "video", "audio", "image"] as const;
export type MediaFilter = (typeof MEDIA_FILTERS)[number];

export interface MediaFilterCounts {
  all: number;
  video: number;
  audio: number;
  image: number;
}

export function hasMediaKind(card: Pick<FeedCard, "hero_image_key" | "audio_key" | "video_key">, filter: MediaFilter): boolean {
  if (filter === "all") return true;
  if (filter === "video") return Boolean(card.video_key);
  if (filter === "audio") return Boolean(card.audio_key);
  return Boolean(card.hero_image_key);
}

export function mediaFilterCounts(cards: readonly Pick<FeedCard, "hero_image_key" | "audio_key" | "video_key">[]): MediaFilterCounts {
  return cards.reduce<MediaFilterCounts>(
    (counts, card) => ({
      all: counts.all + 1,
      video: counts.video + (card.video_key ? 1 : 0),
      audio: counts.audio + (card.audio_key ? 1 : 0),
      image: counts.image + (card.hero_image_key ? 1 : 0),
    }),
    { all: 0, video: 0, audio: 0, image: 0 },
  );
}

export function filterByMedia<T extends Pick<FeedCard, "hero_image_key" | "audio_key" | "video_key">>(
  cards: readonly T[],
  filter: MediaFilter,
): T[] {
  return filter === "all" ? [...cards] : cards.filter((card) => hasMediaKind(card, filter));
}
