import type { FeedCard } from "./types.ts";

const COMPOSITION_WINDOW = 8;
const RECENT_WINDOW = 3;

export type CompositionCard = Pick<
  FeedCard,
  | "id"
  | "type"
  | "render_type"
  | "source_transcripts"
  | "hero_image_key"
  | "audio_key"
  | "video_key"
  | "raw"
>;

function rawRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function producerRunId(card: CompositionCard): string | null {
  return rawString(rawRecord(card.raw.producer)?.run_id);
}

function sourceKey(card: CompositionCard): string | null {
  return card.source_transcripts[0] ?? null;
}

function hasMedia(card: CompositionCard): boolean {
  return Boolean(card.hero_image_key || card.audio_key || card.video_key);
}

function scoreCandidate(
  card: CompositionCard,
  sourceIndex: number,
  output: CompositionCard[],
): number {
  const last = output.at(-1);
  const recent = output.slice(-RECENT_WINDOW);
  let score = sourceIndex * 10;

  if (last?.type === card.type) score += 34;
  if (last?.render_type === card.render_type) score += 10;

  const source = sourceKey(card);
  if (source && sourceKey(last ?? card) === source && last !== undefined) score += 22;

  const runId = producerRunId(card);
  if (runId && producerRunId(last ?? card) === runId && last !== undefined) score += 8;

  score += recent.filter((seen) => seen.type === card.type).length * 14;
  score += recent.filter((seen) => {
    const seenSource = sourceKey(seen);
    return source !== null && seenSource === source;
  }).length * 8;

  if (hasMedia(card) && recent.every((seen) => !hasMedia(seen))) score -= 6;
  return score;
}

/**
 * Compose the visible Feed from newest-first rows.
 *
 * The newest artifact remains first, but the next cards are selected from a
 * bounded recency window to reduce same-type/source/run clumps. This keeps the
 * page fresh without turning Feed into a global ranker that buries new work.
 */
export function composeFeed<T extends CompositionCard>(cards: readonly T[], limit = cards.length): T[] {
  const pending = [...cards];
  const output: T[] = [];
  const take = Math.max(0, Math.min(limit, pending.length));

  while (output.length < take && pending.length > 0) {
    if (output.length === 0) {
      output.push(pending.shift() as T);
      continue;
    }

    const window = pending.slice(0, COMPOSITION_WINDOW);
    let bestIndex = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    window.forEach((card, index) => {
      const score = scoreCandidate(card, index, output);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    output.push(pending.splice(bestIndex, 1)[0] as T);
  }

  return output;
}
