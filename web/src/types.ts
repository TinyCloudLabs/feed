// Viewer-side types for the xyz.tinycloud.artifacts contract.
// - `ArtifactRow` mirrors the §1.1 `feed.artifact` SQL columns the viewer reads.
// - `FeedCard` is the hydrated, render-ready shape (typed columns + the fields
//   pulled from `raw_artifact` + the resolved hero blob URL).
// - `InteractionRow` is the §1.2 append-only row the viewer WRITES.

// The interaction actions (contract §1.2: 6-value enum, modeled on FeedbackEvent).
// V1 viewer surfaces a subset (more/less/save) but the type covers all six so the
// schema and any later UI stay aligned.
export const INTERACTION_ACTIONS = [
  "more",
  "less",
  "save",
  "already_knew",
  "wrong",
  "promote",
] as const;
export type InteractionAction = (typeof INTERACTION_ACTIONS)[number];

/** Precomputed viewer render shape (contract §4). V1 = tweet | article. */
export type RenderType = "tweet" | "article" | "video";

/** Raw row as it comes back from `SELECT * FROM artifact` (contract §1.1). */
export interface ArtifactRow {
  id: string;
  type: string;
  render_type: string;
  slug: string;
  headline: string;
  body_md: string | null;
  quote: string | null;
  attribution: string | null;
  tags: string; // JSON string[]
  source_transcripts: string; // JSON string[]
  hero_image_key: string | null;
  hero_image_sha256: string | null;
  hero_image_mime: string | null;
  audio_key: string | null;
  audio_sha256: string | null;
  audio_mime: string | null;
  video_url: string | null;
  audience: string | null;
  approval_status: string;
  platform: string | null;
  generation_model: string | null;
  critic_pass: number; // 0/1
  quotes_verified: number; // 0/1
  raw_artifact: string; // full Artifact JSON (lossless)
  generated_at: string;
  published_at: string;
  publisher_did: string;
  schema_version: number;
}

/** Hydrated, render-ready card. Typed columns are authoritative; richer fields
 *  come from `raw` (the parsed `raw_artifact`); `hero_image_url` is a blob URL
 *  minted from the KV media bytes (or undefined when there's no hero). */
export interface FeedCard {
  id: string;
  type: string;
  render_type: RenderType;
  slug: string;
  headline: string;
  body_md: string | null;
  quote: string | null;
  attribution: string | null;
  tags: string[];
  source_transcripts: string[];
  hero_image_key: string | null;
  hero_image_url?: string;
  generation_model: string | null;
  critic_pass: boolean;
  quotes_verified: boolean;
  generated_at: string;
  published_at: string;
  /** The full lossless Artifact JSON, for fields not promoted to columns. */
  raw: Record<string, unknown>;
}

/** Append-only interaction event the viewer writes (contract §1.2). */
export interface InteractionRow {
  id: string;
  artifact_id: string;
  artifact_type: string;
  action: InteractionAction;
  note: string | null;
  reader_did: string;
  nonce: string;
  created_at: string;
  recorded_at: string;
}
