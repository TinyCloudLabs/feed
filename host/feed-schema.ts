import type { FeedV1SchemaMigration } from "../../artifactory/skills/_shared/lib/feed-v1-schema.ts";

export const FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL = `INSERT INTO feed_item_projection (
  feed_item_id, target_kind, artifact_id, post_id, rank_score, disposition,
  visibility, freshness_label, reason_codes_json, package_id,
  source_fingerprint, published_at, updated_at
)
SELECT
  'legacy:' || artifact_id, 'artifact_preview', artifact_id, NULL, rank_score,
  disposition, visibility, freshness_label, reason_codes_json, package_id,
  source_fingerprint, published_at, updated_at
FROM feed_artifact_projection
WHERE true
ON CONFLICT(feed_item_id) DO UPDATE SET
  rank_score = excluded.rank_score,
  disposition = excluded.disposition,
  visibility = excluded.visibility,
  freshness_label = excluded.freshness_label,
  reason_codes_json = excluded.reason_codes_json,
  package_id = excluded.package_id,
  source_fingerprint = excluded.source_fingerprint,
  published_at = excluded.published_at,
  updated_at = excluded.updated_at
WHERE excluded.updated_at >= feed_item_projection.updated_at`;

// Ownership during rollout is per mirrored preview row: the side with the
// newer updated_at owns all presentation fields; equal timestamps prefer the
// legacy row so old clients cannot be surprised by a tie.
export const FEED_V1_PREVIEW_TO_LEGACY_RECONCILIATION_SQL = `INSERT INTO feed_artifact_projection (
  artifact_id, rank_score, disposition, visibility, freshness_label,
  reason_codes_json, package_id, source_fingerprint, published_at, updated_at
)
SELECT artifact_id, rank_score, disposition, visibility, freshness_label,
       reason_codes_json, package_id, source_fingerprint, published_at, updated_at
FROM feed_item_projection
WHERE target_kind = 'artifact_preview'
ON CONFLICT(artifact_id) DO UPDATE SET
  rank_score = excluded.rank_score,
  disposition = excluded.disposition,
  visibility = excluded.visibility,
  freshness_label = excluded.freshness_label,
  reason_codes_json = excluded.reason_codes_json,
  package_id = excluded.package_id,
  source_fingerprint = excluded.source_fingerprint,
  published_at = excluded.published_at,
  updated_at = excluded.updated_at
WHERE excluded.updated_at > feed_artifact_projection.updated_at`;

export const FEED_V1_LEGACY_PROJECTION_PARITY_SQL = `SELECT
  (SELECT COUNT(*)
   FROM feed_artifact_projection AS legacy
   LEFT JOIN feed_item_projection AS item
     ON item.feed_item_id = 'legacy:' || legacy.artifact_id
   WHERE item.feed_item_id IS NULL
      OR item.target_kind <> 'artifact_preview'
      OR item.artifact_id <> legacy.artifact_id
      OR item.post_id IS NOT NULL
      OR item.updated_at < legacy.updated_at
      OR item.published_at <> legacy.published_at
      OR item.rank_score <> legacy.rank_score
      OR item.disposition <> legacy.disposition
      OR item.visibility <> legacy.visibility
      OR item.freshness_label <> legacy.freshness_label
      OR item.reason_codes_json <> legacy.reason_codes_json
      OR item.package_id <> legacy.package_id
      OR item.source_fingerprint <> legacy.source_fingerprint)
  +
  (SELECT COUNT(*)
   FROM feed_item_projection AS item
   LEFT JOIN feed_artifact_projection AS legacy
     ON legacy.artifact_id = item.artifact_id
   WHERE item.target_kind = 'artifact_preview'
     AND item.feed_item_id LIKE 'legacy:%'
     AND legacy.artifact_id IS NULL) AS mismatch_count`;

/** Local fallback; bootstrap de-dupes it once the shared contract supplies 002. */
export const FEED_POST_MIGRATION: FeedV1SchemaMigration = {
  id: "002_post_feed_items",
  description: "Create target-aware Feed items and interactions, then backfill artifact previews.",
  sql: [
    `CREATE TABLE IF NOT EXISTS feed_item_projection (
  feed_item_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('post', 'artifact_preview')),
  artifact_id TEXT NOT NULL,
  post_id TEXT,
  rank_score REAL NOT NULL,
  disposition TEXT NOT NULL,
  visibility TEXT NOT NULL,
  freshness_label TEXT NOT NULL,
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  package_id TEXT NOT NULL,
  source_fingerprint TEXT NOT NULL,
  published_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (target_kind = 'post' AND post_id IS NOT NULL) OR
    (target_kind = 'artifact_preview' AND post_id IS NULL)
  )
)`,
    `CREATE TABLE IF NOT EXISTS feed_targeted_interaction_event (
  event_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('artifact', 'post', 'feed_item')),
  artifact_id TEXT,
  post_id TEXT,
  feed_item_id TEXT,
  reader_nonce TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  signal TEXT NOT NULL,
  payload_json TEXT,
  payload_hash TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (target_kind = 'artifact' AND artifact_id IS NOT NULL AND post_id IS NULL AND feed_item_id IS NULL) OR
    (target_kind = 'post' AND artifact_id IS NOT NULL AND post_id IS NOT NULL AND feed_item_id IS NULL) OR
    (target_kind = 'feed_item' AND artifact_id IS NULL AND post_id IS NULL AND feed_item_id IS NOT NULL)
  )
)`,
    FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL,
    `CREATE INDEX IF NOT EXISTS feed_item_projection_artifact_id
  ON feed_item_projection (artifact_id)`,
  ],
};

export const FEED_GENERATION_WORKER_MIGRATION: FeedV1SchemaMigration = {
  id: "003_generation_worker_control",
  description: "Add leased, fenced generation request execution state.",
  sql: [
    "ALTER TABLE generation_request ADD COLUMN run_id TEXT",
    "ALTER TABLE generation_request ADD COLUMN workflow_id TEXT",
    "ALTER TABLE generation_request ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3",
    "ALTER TABLE generation_request ADD COLUMN claim_owner TEXT",
    "ALTER TABLE generation_request ADD COLUMN lease_expires_at TEXT",
    "ALTER TABLE generation_request ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE generation_request ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE generation_request ADD COLUMN next_retry_at TEXT",
    "ALTER TABLE generation_request ADD COLUMN cancellation_requested INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE generation_request ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued'",
    "ALTER TABLE generation_request ADD COLUMN phase_started_at TEXT",
    "ALTER TABLE generation_request ADD COLUMN started_at TEXT",
    "ALTER TABLE generation_request ADD COLUMN completed_at TEXT",
    "ALTER TABLE generation_request ADD COLUMN last_attempt_at TEXT",
    "ALTER TABLE generation_request ADD COLUMN source_cursor_before TEXT",
    "ALTER TABLE generation_request ADD COLUMN source_cursor_after TEXT",
    "ALTER TABLE generation_request ADD COLUMN source_refs_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE generation_request ADD COLUMN publication_key TEXT",
    "ALTER TABLE generation_request ADD COLUMN artifact_ids_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE generation_request ADD COLUMN publication_manifest_json TEXT",
    "ALTER TABLE generation_request ADD COLUMN error_json TEXT",
    "ALTER TABLE generation_request ADD COLUMN timing_events_json TEXT NOT NULL DEFAULT '[]'",
  ],
};

export const FEED_GENERATION_OBSERVABILITY_MIGRATION: FeedV1SchemaMigration = {
  id: "004_generation_observability",
  description: "Persist privacy-safe terminal generation outcomes and worker quality metadata.",
  sql: [
    "ALTER TABLE generation_request ADD COLUMN terminal_kind TEXT CHECK (terminal_kind IN ('published', 'zero_artifacts', 'dead_letter'))",
    "ALTER TABLE generation_request ADD COLUMN error_code TEXT",
    "ALTER TABLE generation_request ADD COLUMN published_manifest_ids_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE generation_request ADD COLUMN critic_verdicts_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE generation_request ADD COLUMN generation_strategy TEXT",
    "ALTER TABLE generation_request ADD COLUMN claimed_at TEXT",
    "ALTER TABLE generation_request ADD COLUMN finished_at TEXT",
    // The legacy-row backfill deliberately lives in application code
    // (FeedHostStorage.backfillGenerationTerminals): the node's SQL authorizer
    // denies json_valid()/json_extract(), and one denied statement no-ops the
    // whole migration while the ledger records success (TC-265, prod 2026-07-22).
    `CREATE INDEX IF NOT EXISTS generation_request_actor_recent
       ON generation_request (actor_id, updated_at DESC)`,
  ],
};

export function withFeedHostMigrations(migrations: readonly FeedV1SchemaMigration[]): FeedV1SchemaMigration[] {
  const byId = new Map(migrations.map((migration) => [migration.id, migration] as const));
  if (!byId.has(FEED_POST_MIGRATION.id)) byId.set(FEED_POST_MIGRATION.id, FEED_POST_MIGRATION);
  if (!byId.has(FEED_GENERATION_WORKER_MIGRATION.id)) {
    byId.set(FEED_GENERATION_WORKER_MIGRATION.id, FEED_GENERATION_WORKER_MIGRATION);
  }
  if (!byId.has(FEED_GENERATION_OBSERVABILITY_MIGRATION.id)) {
    byId.set(FEED_GENERATION_OBSERVABILITY_MIGRATION.id, FEED_GENERATION_OBSERVABILITY_MIGRATION);
  }
  return [...byId.values()];
}
