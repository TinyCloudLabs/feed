import type { FeedCard } from "./types.ts";

export type RawSourceQuote = {
  quote: string;
  speaker: string | null;
  transcript: string | null;
};

export type ProducerTrail = {
  run: string[];
  delegation: string[];
};

export interface DataTrailModel {
  quotes: RawSourceQuote[];
  notes: string | null;
  producer: ProducerTrail;
  sources: string[];
  mediaKeys: string[];
  summaryBits: string[];
}

function rawRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rawString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function fileLeaf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function sourceQuotes(card: FeedCard): RawSourceQuote[] {
  const rawQuotes = Array.isArray(card.raw.source_quotes) ? card.raw.source_quotes : [];
  return rawQuotes.flatMap((entry) => {
    const quote = rawRecord(entry);
    const text = rawString(quote?.quote);
    if (!text) return [];
    return [
      {
        quote: text,
        speaker: rawString(quote?.speaker),
        transcript: rawString(quote?.transcript),
      },
    ];
  });
}

function qualityNotes(card: FeedCard): string | null {
  const quality = rawRecord(card.raw.quality);
  return rawString(quality?.notes);
}

function firstRawString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = rawString(record[key]);
    if (value) return value;
  }
  return null;
}

function producerTrail(card: FeedCard): ProducerTrail {
  const producer = rawRecord(card.raw.producer);
  if (!producer) return { run: [], delegation: [] };
  const runId = firstRawString(producer, "run_id", "runId");
  const target = firstRawString(producer, "target_artifact_type", "targetArtifactType");
  const mediaFocus = firstRawString(producer, "media_focus", "mediaFocus");
  const executionSource =
    firstRawString(producer, "execution_source_label", "executionSourceLabel") ??
    firstRawString(producer, "execution_source", "executionSource");
  const executionEntrypoint = firstRawString(producer, "execution_entrypoint", "executionEntrypoint");
  const publishedAt = firstRawString(producer, "published_by_agent_at", "publishedByAgentAt");
  const delegationCid = firstRawString(producer, "delegation_cid", "delegationCid");
  const delegationExpiresAt = firstRawString(producer, "delegation_expires_at", "delegationExpiresAt");
  const delegatedSpace = firstRawString(producer, "delegated_space", "delegatedSpace");

  return {
    run: [
      rawString(producer.pipeline),
      runId ? `run=${runId}` : null,
      executionSource ? `source=${executionSource}` : null,
      executionEntrypoint ? `entry=${executionEntrypoint}` : null,
      target ? `target=${target}` : null,
      mediaFocus ? `media=${mediaFocus}` : null,
      publishedAt ? `agent_publish=${publishedAt}` : null,
    ].filter((field): field is string => Boolean(field)),
    delegation: [
      delegationCid ? `cid=${delegationCid}` : null,
      delegationExpiresAt ? `expires=${delegationExpiresAt}` : null,
      delegatedSpace ? `space=${delegatedSpace}` : null,
    ].filter((field): field is string => Boolean(field)),
  };
}

export function buildDataTrail(card: FeedCard): DataTrailModel {
  const quotes = sourceQuotes(card);
  const notes = qualityNotes(card);
  const producer = producerTrail(card);
  const sources = card.source_transcripts.map(fileLeaf);
  const mediaKeys = [
    card.hero_image_key ? `hero=${card.hero_image_key}` : null,
    card.audio_key ? `audio=${card.audio_key}` : null,
    card.video_key ? `video=${card.video_key}` : null,
  ].filter((field): field is string => Boolean(field));
  const summaryBits = [
    sources.length > 0 ? `${sources.length} source${sources.length === 1 ? "" : "s"}` : null,
    quotes.length > 0 ? `${quotes.length} quote${quotes.length === 1 ? "" : "s"}` : null,
    mediaKeys.length > 0 ? `${mediaKeys.length} media` : null,
    producer.run.length > 0 ? "run" : null,
    producer.delegation.length > 0 ? "delegation" : null,
  ].filter((field): field is string => Boolean(field));

  return { quotes, notes, producer, sources, mediaKeys, summaryBits };
}
