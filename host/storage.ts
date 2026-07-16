import {
  artifactIndexRow,
  packageStateRow,
} from "../../artifactory/skills/_shared/lib/feed-v1-bootstrap.ts";
import type {
  DelegatedAccess,
  IDatabaseHandle,
  QueryResponse,
  SqlStatement,
  SqlValue,
} from "@tinycloud/node-sdk";
import {
  type CredentialMode,
  type FeedArtifact,
  type FeedArtifactProjection,
  type FeedbackEvent,
  type FeedWorkflowPackage,
  type FeedWorkflowRun,
  type WorkflowDisclosure,
  type WorkflowPresentation,
  validateFeedArtifact,
} from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import {
  applyFeedV1MigrationPlan,
  buildFeedV1MigrationPlan,
  LEGACY_FEED_DB_PATH,
  LEGACY_INTERACTIONS_DB_PATH,
  type FeedV1MigrationSummary,
  type FeedV1MigrationWriter,
  type MigratedFeedArtifact,
} from "../../artifactory/skills/_shared/lib/feed-v1-migration.ts";
import {
  assertFeedV1SchemaUsesMigrations,
  feedV1MigrationApplyPlans,
  type FeedV1SqlResourceName,
} from "../../artifactory/skills/_shared/lib/feed-v1-schema.ts";
import type { SqlSeedRow } from "../../artifactory/skills/_shared/lib/feed-v1-bootstrap.ts";
import {
  FEED_HOST_ARTIFACT_DOC_PREFIX,
  FEED_HOST_ARTIFACTS_DB_PATH,
  FEED_HOST_FEED_DB_PATH,
  FEED_HOST_FEED_SETTINGS_PREFIX,
  normalizeActorId,
} from "./delegation.ts";
import {
  buildFeedEvents,
  defaultFeedPreferences,
  filterFeedEventsAfterId,
  type FeedControlIntentInput,
  type FeedGenerationRequestRecord,
  type FeedPreferenceProfileRecord,
  type FeedPreferenceValue,
  type FeedProjectionState,
  type FeedReconcileArtifact,
  type FeedReconcilePlan,
  hashJson,
  mergeFeedPreferences,
  rankFeedProjections,
  reconcileFeedProjections,
  renderFeedEventStream,
  summarizeFeedbackEvents,
  sanitizePreferenceValue,
  FEED_HOST_PREFERENCES_SCOPE,
} from "./logic.ts";
import {
  postsFromArtifact,
  feedItemIdForPost,
  validateFeedItemProjection,
  validateFeedItemProjectionJoin,
  type FeedInteractionTarget,
  type FeedItemProjection,
  type FeedTargetedInteractionEvent,
} from "../shared/feed-item.ts";
import {
  FEED_V1_LEGACY_PROJECTION_PARITY_SQL,
  FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL,
  FEED_V1_PREVIEW_TO_LEGACY_RECONCILIATION_SQL,
  withFeedHostMigrations,
} from "./feed-schema.ts";

type ProjectionRow = {
  feed_item_id: string;
  target_kind: "post" | "artifact_preview";
  artifact_id: string;
  post_id: string | null;
  artifact_type: string;
  rank_score: number;
  disposition: FeedArtifactProjection["disposition"];
  visibility: FeedArtifactProjection["visibility"];
  freshness_label: FeedArtifactProjection["freshnessLabel"];
  reason_codes_json: string;
  package_id: string;
  source_fingerprint: string;
  published_at: string;
  updated_at: string;
};

type ArtifactIndexRow = {
  artifact_id: string;
  artifact_type: string;
  package_id: string;
  source_fingerprint: string;
  doc_key: string;
  published_at: string;
  updated_at: string;
};

type FeedbackRow = {
  target: FeedInteractionTarget;
  signal: FeedbackEvent["signal"];
  createdAt: string;
};

type FeedbackDbRow = {
  eventId: string;
  targetKind: FeedInteractionTarget["kind"];
  artifactId: string | null;
  postId: string | null;
  feedItemId: string | null;
  signal: FeedbackEvent["signal"];
  createdAt: string;
};

type PreferenceRow = {
  profile_id: string;
  actor_id: string;
  scope: string;
  value_json: string;
  version: number;
  updated_at: string;
};

type ControlIntentRow = {
  event_id: string;
  reader_nonce: string;
  actor_id: string;
  intent_kind: string;
  status: string;
  target_ref: string;
  payload_hash: string | null;
  payload_json: string | null;
  created_at: string;
};

type SkillCredentialsRow = {
  profile_id: string;
  scope: string;
  value_json: string;
  version: number;
  updated_at: string;
};

type StoredSkillCredentialsValue = {
  skillId: string;
  credentialMode: CredentialMode;
  providerId?: string;
  secretRef?: string;
  budget?: {
    budgetId: string;
    limit?: number;
    spent?: number;
    currency?: string;
    disabled?: boolean;
  };
};

// Wire representation of a skill's credential state. NEVER carries the raw
// secretRef — only a boolean marker — so a submitted secret value can't leak
// through GET/PATCH responses or error bodies.
export type FeedHostSkillBudgetState = {
  budgetId: string;
  limit?: number;
  spent: number;
  currency: string;
  disabled: boolean;
  remaining?: number;
  status: "ready" | "blocked_budget";
};

export type FeedHostSkillState = {
  skillId: string;
  credentialMode: CredentialMode;
  providerId?: string;
  hasSecret: boolean;
  budget: FeedHostSkillBudgetState;
  version: number;
  updatedAt: string;
};

// Internal record — server-side only. Holds the raw secretRef so we can carry
// it forward across upserts. Never returned to callers.
type FeedHostSkillRecord = Omit<FeedHostSkillState, "hasSecret"> & {
  secretRef?: string;
};

type WorkflowPackageStateRow = {
  package_id: string;
  display_name: string;
  version: string;
  admission_state: string;
  disclosure_json: string;
  enabled_at: string | null;
  paused_at: string | null;
  updated_at: string;
};

type WorkflowRunIndexRow = {
  run_id: string;
  package_id: string;
  status: string;
  published_artifact_ids_json: string;
  error_json: string | null;
  started_at: string;
  finished_at: string | null;
};

type WorkflowExampleRow = {
  // No post_title column exists on feed_item_projection; kept absent on purpose.
  artifact_id: string;
  package_id: string;
  published_at: string;
};

export type FeedHostWorkflowRunSummary = {
  runId: string;
  status: FeedWorkflowRun["status"];
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  publishedArtifactCount: number;
  error?: { code: string; message: string };
};

export type FeedHostWorkflowExample = {
  artifactId: string;
  title: string | null;
  publishedAt: string;
};

// Wire shape for GET /workflows. Deliberately excludes package digests,
// manifest/workflow refs, budget ids, and any capability material — those
// belong to a future advanced-diagnostics disclosure, not the routine list.
export type FeedHostWorkflowState = {
  packageId: string;
  displayName: string;
  version: string;
  settingsVersion: number;
  admissionState: FeedWorkflowPackage["admissionState"];
  disclosure: WorkflowDisclosure;
  presentation?: WorkflowPresentation;
  paused: boolean;
  disabled: boolean;
  cadence?: "more" | "normal" | "less";
  settings?: {
    sourceSelection?: "recent_authorized" | "named_sources" | "all_authorized";
    audience?: "private" | "team" | "draft";
    outputVolume?: "short" | "standard" | "detailed";
  };
  enabledAt: string | null;
  updatedAt: string;
  lastRun?: FeedHostWorkflowRunSummary;
  example?: FeedHostWorkflowExample;
};

export type FeedHostSkillCredentialsPatch = {
  expectedVersion: number;
  credentialMode: CredentialMode;
  providerId?: string;
  secretRef?: string;
  budget?: {
    budgetId?: string;
    limit?: number;
    spent?: number;
    currency?: string;
    disabled?: boolean;
  };
};

type GenerationRequestRow = {
  request_id: string;
  reader_nonce: string;
  actor_id: string;
  status: FeedGenerationRequestRecord["status"];
  scope_json: string;
  package_id: string | null;
  dedupe_key: string | null;
  prompt: string | null;
  run_id: string | null;
  workflow_id: string | null;
  max_attempts: number;
  claim_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  attempt_count: number;
  next_retry_at: string | null;
  cancellation_requested: number;
  phase: string;
  phase_started_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  last_attempt_at: string | null;
  source_cursor_before: string | null;
  source_cursor_after: string | null;
  source_refs_json: string;
  publication_key: string | null;
  artifact_ids_json: string;
  publication_manifest_json: string | null;
  error_json: string | null;
  timing_events_json: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type FeedGenerationClaimInput = {
  workflowId: string;
  claimOwner: string;
  now: string;
  leaseExpiresAt: string;
  maxAttempts: number;
};

export type FeedGenerationTimingEvent = {
  name: string;
  at: string;
  durationMs?: number;
};

export type FeedGenerationMetadataPatch = {
  sourceCursorAfter?: unknown;
  sourceRefs?: unknown[];
  timingEvents?: FeedGenerationTimingEvent[];
};

export type FeedGenerationMutationIdentity = {
  requestId: string;
  runId: string;
  claimOwner: string;
  fencingToken: number;
  now: string;
};

export type FeedHostActorStorage = {
  actorId: string;
  artifacts: DelegatedAccess;
  feed: DelegatedAccess;
  settings: DelegatedAccess;
  documents: DelegatedAccess;
  media?: DelegatedAccess;
  legacyArtifacts?: DelegatedAccess;
  legacyInteractions?: DelegatedAccess;
};

export type FeedHostStorageOptions = {
  migrateLegacyData?: (actor: FeedHostActorStorage) => Promise<FeedV1MigrationSummary>;
  // Intake backpressure: reject new generation requests once an actor has this
  // many live (accepted/pending, unexpired) requests waiting for a worker.
  maxPendingGenerationRequests?: number;
};

export type FeedProjectionParity = {
  legacyRows: number;
  matchingRows: number;
  mismatchedRows: number;
  readyToRetireLegacyReads: boolean;
};

export type ArtifactHero = {
  bytes: Uint8Array;
  contentType: string;
};

export const DEFAULT_MAX_PENDING_GENERATION_REQUESTS = 8;

export class FeedHostError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FeedHostError";
  }
}

const DB_PATHS: Record<FeedV1SqlResourceName, string> = {
  artifacts_index: FEED_HOST_ARTIFACTS_DB_PATH,
  feed_index: FEED_HOST_FEED_DB_PATH,
};

const GENERATION_REQUEST_COLUMNS = `request_id, reader_nonce, actor_id, status, scope_json,
  package_id, dedupe_key, prompt, run_id, workflow_id, max_attempts, claim_owner, lease_expires_at, fencing_token,
  attempt_count, next_retry_at, cancellation_requested, phase, phase_started_at, started_at,
  completed_at, last_attempt_at, source_cursor_before, source_cursor_after, source_refs_json,
  publication_key, artifact_ids_json, publication_manifest_json, error_json, timing_events_json,
  expires_at, created_at, updated_at`;

function storageCacheKey(actor: FeedHostActorStorage): string {
  return normalizeActorId(actor.actorId);
}

export class FeedHostStorage {
  private readonly bootstrapped = new WeakSet<object>();
  private readonly projectionCache = new Map<string, FeedProjectionState[]>();
  private readonly feedbackCache = new Map<string, FeedbackRow[]>();
  private readonly preferenceCache = new Map<string, FeedPreferenceProfileRecord[]>();
  private readonly migrateLegacyDataHook: (actor: FeedHostActorStorage) => Promise<FeedV1MigrationSummary>;
  private readonly maxPendingGenerationRequests: number;

  constructor(options: FeedHostStorageOptions = {}) {
    this.migrateLegacyDataHook = options.migrateLegacyData ?? ((actor) => this.performLegacyMigration(actor));
    this.maxPendingGenerationRequests =
      options.maxPendingGenerationRequests ??
      Number(process.env.FEED_HOST_MAX_PENDING_GENERATION ?? DEFAULT_MAX_PENDING_GENERATION_REQUESTS);
  }

  async bootstrapSchema(actor: FeedHostActorStorage): Promise<FeedV1MigrationSummary> {
    if (this.bootstrapped.has(actor)) return emptyMigrationSummary();
    assertFeedV1SchemaUsesMigrations();
    for (const plan of feedV1MigrationApplyPlans()) {
      const db = this.db(actor, plan.dbName);
      const migrated = await applyMigrations(db, {
        namespace: plan.namespace,
        migrations: plan.dbName === "feed_index"
          ? withFeedHostMigrations(plan.migrations)
          : plan.migrations,
      });
      if (!migrated.ok) throw new Error(`Failed to initialize ${plan.dbName}: ${resultError(migrated)}`);
    }
    await execute(this.db(actor, "feed_index"), FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL);
    await execute(this.db(actor, "feed_index"), FEED_V1_PREVIEW_TO_LEGACY_RECONCILIATION_SQL);
    const migrationSummary = await this.migrateLegacyDataHook(actor);
    this.bootstrapped.add(actor);
    return migrationSummary;
  }

  async reconcileProjectionCompatibility(actor: FeedHostActorStorage): Promise<void> {
    await execute(this.db(actor, "feed_index"), FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL);
    await execute(this.db(actor, "feed_index"), FEED_V1_PREVIEW_TO_LEGACY_RECONCILIATION_SQL);
    this.projectionCache.delete(storageCacheKey(actor));
  }

  async hasArtifacts(actor: FeedHostActorStorage): Promise<boolean> {
    const rows = await queryRows<{ artifact_id: string }>(
      this.db(actor, "artifacts_index"),
      "SELECT artifact_id FROM artifact_index LIMIT 1",
    );
    return rows.length > 0;
  }

  async insertSeedRows(actor: FeedHostActorStorage, dbName: FeedV1SqlResourceName, rows: SqlSeedRow[]): Promise<void> {
    if (rows.length === 0) return;
    await batch(
      this.db(actor, dbName),
      rows.map((row) => ({ sql: insertSql(row), params: Object.values(row.values).map(sqlValue) })),
    );
  }

  // Admit reviewed packages for this actor so unrun routines appear in the
  // workflow library. Inserts only missing package ids — existing rows keep
  // their enabled_at/paused_at state (seed inserts use INSERT OR REPLACE,
  // which would otherwise clobber a user's pause).
  async ensureWorkflowPackages(
    actor: FeedHostActorStorage,
    packages: FeedWorkflowPackage[],
    now: string,
  ): Promise<void> {
    if (packages.length === 0) return;
    const rows = await queryRows<{ package_id: string }>(
      this.db(actor, "artifacts_index"),
      "SELECT package_id FROM workflow_package_state",
    );
    const existing = new Set(rows.map((row) => row.package_id));
    const missing = packages.filter((pkg) => !existing.has(pkg.packageId));
    if (missing.length === 0) return;
    await this.insertSeedRows(actor, "artifacts_index", missing.map((pkg) => packageStateRow(pkg, now)));
  }

  async writeArtifactDocument(actor: FeedHostActorStorage, artifact: FeedArtifact | MigratedFeedArtifact): Promise<void> {
    const result = await actor.documents.kv.put(artifactDocKey(artifact.storage.docKey), artifact, {
      contentType: "application/json",
    });
    if (!result.ok) throw new Error(`Failed to write artifact document: ${resultError(result)}`);
  }

  async listFeed(
    actor: FeedHostActorStorage,
    input: { limit: number; cursor?: string; includeQuarantined?: boolean },
  ): Promise<{ items: FeedItemProjection[]; nextCursor?: string }> {
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error("cursor must be a non-negative integer offset");
    const limit = Math.max(1, Math.min(input.limit, 100));
    const [projectionRows, feedbackRows, preferenceRows] = await Promise.all([
      this.readCachedProjectionStates(actor),
      this.readCachedFeedbackRows(actor),
      this.readCachedPreferenceProfiles(actor),
    ]);
    // Quarantine is enforced before composition, ranking, and pagination so a
    // broken row cannot consume a page slot or influence diversity scoring.
    // The opt-in is deliberately storage-internal; GET /feed never exposes it.
    const readableRows = input.includeQuarantined
      ? projectionRows
      : projectionRows.filter(
          (row) => row.visibility !== "repair_only" && !row.reasonCodes.includes("broken_ref"),
        );
    const postArtifactIds = new Set(
      readableRows.filter((row) => row.target.kind === "post").map((row) => row.target.artifactId),
    );
    const composedRows = readableRows.filter(
      (row) => row.target.kind !== "artifact_preview" || !postArtifactIds.has(row.target.artifactId),
    );
    const ranked = rankFeedProjections({
      items: composedRows,
      feedbackByArtifact: summarizeFeedbackEvents(feedbackRows),
      preferences: mergeFeedPreferences(preferenceRows),
    });
    const page = ranked.slice(offset, offset + limit);
    return {
      // Keep the ranked page request lightweight. Artifact documents are
      // hydrated progressively by the client; fetching dozens of documents
      // here can exhaust TinyCloud's connection pool and outlive the proxy.
      items: page.map((row) => stripProjectionState(row)),
      nextCursor: ranked.length > offset + limit ? String(offset + limit) : undefined,
    };
  }

  async checkProjectionParity(actor: FeedHostActorStorage): Promise<FeedProjectionParity> {
    const rows = await queryRows<{ legacy_rows: number; matching_rows: number; mismatch_count: number }>(
      this.db(actor, "feed_index"),
      FEED_V1_LEGACY_PROJECTION_PARITY_SQL,
    );
    const legacyRows = Number(rows[0]?.legacy_rows ?? 0);
    const matchingRows = Number(rows[0]?.matching_rows ?? 0);
    const mismatchedRows = Number(rows[0]?.mismatch_count ?? Math.max(0, legacyRows - matchingRows));
    return { legacyRows, matchingRows, mismatchedRows, readyToRetireLegacyReads: mismatchedRows === 0 };
  }

  async readArtifact(
    actor: FeedHostActorStorage,
    artifactId: string,
  ): Promise<
    | { kind: "found"; artifact: FeedArtifact }
    | { kind: "not_found" }
    | { kind: "hydration_failed"; artifactId: string; docKey: string }
  > {
    const rows = await queryRows<ArtifactIndexRow>(
      this.db(actor, "artifacts_index"),
      "SELECT artifact_id, artifact_type, package_id, source_fingerprint, doc_key, published_at, updated_at FROM artifact_index WHERE artifact_id = ?",
      [artifactId],
    );
    const row = rows[0];
    if (!row) return { kind: "not_found" };
    const result = await actor.documents.kv.get<FeedArtifact | string>(artifactDocKey(row.doc_key));
    if (!result.ok) {
      if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") {
        return { kind: "hydration_failed", artifactId: row.artifact_id, docKey: row.doc_key };
      }
      throw new Error(`Failed to read artifact document: ${resultError(result)}`);
    }
    const hydrated = hydrateArtifactDocument(result.data.data);
    if (hydrated.kind !== "found") {
      return { kind: "hydration_failed", artifactId: row.artifact_id, docKey: row.doc_key };
    }
    return hydrated;
  }

  async getArtifact(actor: FeedHostActorStorage, artifactId: string): Promise<FeedArtifact | null> {
    const result = await this.readArtifact(actor, artifactId);
    return result.kind === "found" ? result.artifact : null;
  }

  async readArtifactHero(actor: FeedHostActorStorage, artifactId: string): Promise<ArtifactHero | null> {
    const result = await this.readArtifact(actor, artifactId);
    if (result.kind !== "found") return null;
    const reference = artifactHeroReference(result.artifact.body);
    if (!reference) return null;
    // Migrated distillery docs store a bare filename ("hero.png") whose blob
    // lives under the artifact's media directory, usually as base64 with a
    // .b64 suffix. Try candidates in order until one resolves.
    for (const candidate of heroKeyCandidates(reference.key, result.artifact.artifactId)) {
      const key = artifactMediaKey(candidate);
      if (!key) continue;
      const media = await (actor.media ?? actor.documents).kv.get<string>(key);
      if (!media.ok) {
        if (media.error.code === "KV_NOT_FOUND" || media.error.code === "NOT_FOUND") continue;
        throw new Error(`Failed to read artifact hero: ${resultError(media)}`);
      }
      if (typeof media.data.data !== "string") continue;
      const decoded = decodeBase64Media(media.data.data);
      if (!decoded) continue;
      return {
        bytes: decoded.bytes,
        contentType: reference.contentType ?? decoded.contentType ?? imageContentType(key),
      };
    }
    return null;
  }

  async getProvenance(
    actor: FeedHostActorStorage,
    artifactId: string,
  ): Promise<Pick<FeedArtifact, "artifactId" | "sourceRefs" | "producedBy" | "freshness" | "idempotency"> | null> {
    const result = await this.readArtifact(actor, artifactId);
    if (result.kind === "not_found") return null;
    if (result.kind === "hydration_failed") {
      throw new FeedHostError("artifact hydration failed", 424, "hydration_failed");
    }
    return {
      artifactId: result.artifact.artifactId,
      sourceRefs: result.artifact.sourceRefs,
      producedBy: result.artifact.producedBy,
      freshness: result.artifact.freshness,
      idempotency: result.artifact.idempotency,
    };
  }

  async readPreferenceProfile(
    actor: FeedHostActorStorage,
    scope: string = FEED_HOST_PREFERENCES_SCOPE,
  ): Promise<FeedPreferenceProfileRecord | null> {
    return this.readPreferenceProfileByActor(actor, actor.actorId, normalizePreferenceScope(scope));
  }

  async listPreferenceProfiles(actor: FeedHostActorStorage): Promise<FeedPreferenceProfileRecord[]> {
    const rows = await queryRows<PreferenceRow>(
      this.db(actor, "feed_index"),
      "SELECT profile_id, actor_id, scope, value_json, version, updated_at FROM preference_profile WHERE actor_id = ? ORDER BY scope ASC, version DESC, updated_at DESC",
      [normalizeActorId(actor.actorId)],
    );
    return rows.map(preferenceRecordFromRow);
  }

  async putPreferenceProfile(
    actor: FeedHostActorStorage,
    input: {
      scope?: string;
      expectedVersion?: number;
      patch?: FeedPreferenceValue;
      reset?: boolean;
      updatedAt?: string;
      actorId: string;
    },
  ): Promise<FeedPreferenceProfileRecord> {
    const scope = normalizePreferenceScope(input.scope);
    const normalizedActorId = normalizeActorId(input.actorId);
    const now = input.updatedAt ?? new Date().toISOString();
    const current = await this.readPreferenceProfileByActor(actor, normalizedActorId, scope);
    const currentVersion = current?.version ?? 0;
    if (current) {
      if (input.expectedVersion === undefined || input.expectedVersion !== currentVersion) {
        throw new FeedHostError("preference version conflict", 409, "version_conflict", { currentVersion });
      }
    } else if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
      throw new FeedHostError("preference version conflict", 409, "version_conflict", { currentVersion });
    }

    const value = input.reset
      ? defaultPreferenceValue()
      : mergePreferencePatch(current?.value ?? defaultPreferenceValue(), input.patch ?? {});
    const record: FeedPreferenceProfileRecord = {
      profileId: preferenceProfileId(normalizedActorId, scope),
      actorId: normalizedActorId,
      scope,
      value,
      version: currentVersion + 1,
      updatedAt: now,
    };
    await this.writePreferenceProfileRecord(actor, record);
    return record;
  }

  async reconcileFeedProjection(actor: FeedHostActorStorage): Promise<FeedReconcilePlan> {
    // Rolling compatibility: old writers remain authoritative only when their
    // updated_at is newer. This also repairs partial old->new writes.
    await execute(this.db(actor, "feed_index"), FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL);
    await execute(this.db(actor, "feed_index"), FEED_V1_PREVIEW_TO_LEGACY_RECONCILIATION_SQL);
    const artifactRows = await this.readArtifactIndexRows(actor);
    const currentRows = await this.readProjectionStates(actor, artifactRows);
    // Reconciliation can spend minutes validating remote artifact documents.
    // Keep the last complete projection snapshot readable while that repair
    // continues instead of making /feed repeat the same remote index scans.
    this.projectionCache.set(storageCacheKey(actor), currentRows);
    const artifacts: FeedReconcileArtifact[] = [];
    for (const artifactRow of artifactRows) {
      const current = currentRows.find((row) => row.target.artifactId === artifactRow.artifact_id);
      const artifactResult = await this.readArtifactDocument(actor, artifactRow.doc_key);
      if (artifactResult.kind === "malformed" || artifactResult.kind === "schema_mismatch") {
        console.warn("Feed Host skipped invalid artifact doc during hydration", {
          artifactId: artifactRow.artifact_id,
          docKey: artifactRow.doc_key,
          reason: artifactResult.kind,
          ...(artifactResult.kind === "schema_mismatch" ? { errors: artifactResult.errors } : { error: artifactResult.error }),
        });
      }
      artifacts.push({
        artifactId: artifactRow.artifact_id,
        artifactType: artifactRow.artifact_type,
        packageId: artifactRow.package_id,
        sourceFingerprint: artifactRow.source_fingerprint,
        publishedAt: artifactRow.published_at,
        updatedAt: artifactRow.updated_at,
        freshnessLabel: artifactResult.kind === "found" ? artifactResult.artifact.freshness.label : current?.freshnessLabel ?? "source_unavailable",
        docMissing: artifactResult.kind !== "found",
        posts: artifactResult.kind === "found" ? postsFromArtifact(artifactResult.artifact) : [],
        surfaceMode: artifactResult.kind === "found"
          ? (artifactResult.artifact as unknown as { feedSurface?: { mode?: "posts" | "artifact_preview" | "none" } }).feedSurface?.mode
          : undefined,
      });
    }
    const plan = reconcileFeedProjections({ artifacts, projections: currentRows });
    const statements: SqlStatement[] = plan.upserts.flatMap((row) => [
      projectionSqlRow(row),
      ...(row.target.kind === "artifact_preview" ? [legacyProjectionSqlRow(row)] : []),
    ]);
    const mirrored = new Set(plan.upserts.filter((row) => row.target.kind === "artifact_preview").map((row) => row.feedItemId));
    for (const row of plan.desired) {
      if (row.target.kind === "artifact_preview" && !mirrored.has(row.feedItemId)) statements.push(legacyProjectionSqlRow(row));
    }
    if (plan.deletions.length > 0) {
      statements.push({
        sql: `DELETE FROM feed_item_projection WHERE feed_item_id IN (${plan.deletions.map(() => "?").join(", ")})`,
        params: plan.deletions,
      });
      const deletedArtifactIds = currentRows
        .filter((row) => plan.deletions.includes(row.feedItemId) && row.target.kind === "artifact_preview")
        .map((row) => row.target.artifactId);
      if (deletedArtifactIds.length > 0) {
        statements.push({
          sql: `DELETE FROM feed_artifact_projection WHERE artifact_id IN (${deletedArtifactIds.map(() => "?").join(", ")})`,
          params: deletedArtifactIds,
        });
      }
    }
    statements.push({
      sql: `INSERT OR REPLACE INTO projection_checkpoint (
        checkpoint_id, source_kind, artifact_cursor, last_reconciled_at, status
      ) VALUES (?, ?, ?, ?, ?)`,
      params: [
        plan.checkpoint.checkpointId,
        plan.checkpoint.sourceKind,
        plan.checkpoint.artifactCursor,
        plan.checkpoint.lastReconciledAt,
        plan.checkpoint.status,
      ],
    });
    await batch(this.db(actor, "feed_index"), statements);
    const parity = await this.checkProjectionParity(actor);
    if (!parity.readyToRetireLegacyReads) {
      console.warn("Feed Host projection parity gate remains closed", parity);
    }
    this.projectionCache.set(storageCacheKey(actor), plan.desired);
    return plan;
  }

  async recordFeedback(
    actor: FeedHostActorStorage,
    event: FeedTargetedInteractionEvent,
  ): Promise<{ eventId: string; duplicate: boolean; status: "applied" | "noop" }> {
    const normalizedActorId = normalizeActorId(event.actorId);
    const existing = await this.findFeedbackEvent(actor, normalizedActorId, event.readerNonce);
    if (existing) return { eventId: existing.eventId, duplicate: true, status: "noop" };
    const projection = await this.readProjectionTarget(actor, event.target);
    if (!projection) {
      throw new FeedHostError("interaction target does not exist", 400, "invalid_feedback_target");
    }

    const payloadHash = event.payloadHash ?? hashJson(event.payload ?? null);
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO feed_targeted_interaction_event (
          event_id, target_kind, artifact_id, post_id, feed_item_id, reader_nonce,
          actor_id, signal, payload_json, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          event.eventId,
          event.target.kind,
          "artifactId" in event.target ? event.target.artifactId : null,
          event.target.kind === "post" ? event.target.postId : null,
          event.target.kind === "feed_item" ? event.target.feedItemId : null,
          event.readerNonce,
          normalizedActorId,
          event.signal,
          event.payload === undefined ? null : JSON.stringify(event.payload),
          payloadHash,
          event.createdAt,
        ],
      },
    ];
    if (event.target.kind === "artifact") {
      statements.push({
        sql: `INSERT INTO feedback_event (
          event_id, artifact_id, reader_nonce, actor_id, signal, payload_json, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          event.eventId,
          event.target.artifactId,
          event.readerNonce,
          normalizedActorId,
          event.signal,
          event.payload === undefined ? null : JSON.stringify(event.payload),
          payloadHash,
          event.createdAt,
        ],
      });
    }
    const disposition = dispositionForSignal(event.signal);
    if (disposition) {
      statements.push({
        sql: projectionDispositionSql(event.target),
        params: projectionDispositionParams(event.target, disposition, event.createdAt),
      });
    }
    await batch(this.db(actor, "feed_index"), statements);
    this.feedbackCache.delete(storageCacheKey(actor));
    if (disposition) this.projectionCache.delete(storageCacheKey(actor));

    if (event.signal === "show_fewer") {
      if (projection) {
        await this.bumpShowFewerPreference(actor, normalizedActorId, projection.package_id, event.createdAt);
      }
    }

    return { eventId: event.eventId, duplicate: false, status: "applied" };
  }

  async recordControlIntent(
    actor: FeedHostActorStorage,
    event: FeedControlIntentInput,
  ): Promise<{ eventId: string; duplicate: boolean; status: string; requestId?: string }> {
    const normalizedActorId = normalizeActorId(event.actorId ?? actor.actorId);
    const existing = await this.findControlIntent(actor, normalizedActorId, event.readerNonce);
    if (existing) {
      return {
        eventId: existing.event_id,
        duplicate: true,
        status: existing.status,
        requestId: await this.findGenerationRequestId(actor, normalizedActorId, event.readerNonce),
      };
    }

    const intentKind = normalizeControlIntentKind(event.intentKind);
    const payloadHash = event.payloadHash ?? hashJson(event.payload ?? null);
    const effect = await this.applyControlIntentEffect(actor, {
      ...event,
      actorId: normalizedActorId,
      intentKind,
      payloadHash,
    });

    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO control_intent_event (
          event_id, reader_nonce, actor_id, intent_kind, status, target_ref, payload_hash, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          event.eventId,
          event.readerNonce,
          normalizedActorId,
          intentKind,
          effect.status,
          event.targetRef,
          payloadHash,
          event.payload === undefined ? null : JSON.stringify(event.payload),
          event.createdAt,
        ],
      },
    ];
    if (effect.generationRequestStatement) statements.push(effect.generationRequestStatement);
    await batch(this.db(actor, "feed_index"), statements);

    if (effect.error) throw effect.error;
    return { eventId: event.eventId, duplicate: false, status: effect.status, requestId: effect.requestId };
  }

  async listControlIntents(actor: FeedHostActorStorage, limit = 100): Promise<ControlIntentRow[]> {
    const rows = await queryRows<ControlIntentRow>(
      this.db(actor, "feed_index"),
      `SELECT event_id, reader_nonce, actor_id, intent_kind, status, target_ref, payload_hash, payload_json, created_at
         FROM control_intent_event
        WHERE actor_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      [normalizeActorId(actor.actorId), Math.max(1, Math.min(limit, 500))],
    );
    return rows;
  }

  async listGenerationRequests(
    actor: FeedHostActorStorage,
    limit = 100,
    filter: { status?: string; excludeExpired?: boolean; order?: "asc" | "desc" } = {},
  ): Promise<GenerationRequestRow[]> {
    const conditions = ["actor_id = ?"];
    const params: SqlValue[] = [normalizeActorId(actor.actorId)];
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      params.push(filter.status);
    }
    if (filter.excludeExpired) {
      conditions.push("expires_at > ?");
      params.push(new Date().toISOString());
    }
    params.push(Math.max(1, Math.min(limit, 500)));
    const rows = await queryRows<GenerationRequestRow>(
      this.db(actor, "feed_index"),
      `SELECT ${GENERATION_REQUEST_COLUMNS}
         FROM generation_request
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at ${filter.order === "asc" ? "ASC" : "DESC"}
        LIMIT ?`,
      params,
    );
    return rows;
  }

  async claimGenerationRequest(
    actor: FeedHostActorStorage,
    input: FeedGenerationClaimInput,
  ): Promise<FeedGenerationRequestRecord | null> {
    const actorId = normalizeActorId(actor.actorId);
    const db = this.db(actor, "feed_index");
    await execute(
      db,
      `UPDATE generation_request
          SET status = 'dead_letter', phase = 'dead_letter', completed_at = ?, updated_at = ?
        WHERE actor_id = ? AND status = 'pending' AND lease_expires_at <= ?
          AND attempt_count >= max_attempts AND phase NOT IN ('publishing', 'reconciling')`,
      [input.now, input.now, actorId, input.now],
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = await queryRows<GenerationRequestRow>(
        db,
        `SELECT ${GENERATION_REQUEST_COLUMNS}
           FROM generation_request AS candidate
          WHERE actor_id = ? AND expires_at > ? AND (workflow_id IS NULL OR workflow_id = ?) AND (
            (attempt_count < max_attempts AND (
              status = 'accepted'
              OR (status = 'retry_wait' AND next_retry_at <= ?)
              OR (status = 'pending' AND lease_expires_at <= ? AND phase NOT IN ('publishing', 'reconciling'))
            ))
            OR (status = 'pending' AND lease_expires_at <= ? AND phase IN ('publishing', 'reconciling'))
          )
          AND NOT EXISTS (
            SELECT 1 FROM generation_request AS inflight
             WHERE inflight.actor_id = candidate.actor_id
               AND inflight.workflow_id = ?
               AND inflight.status = 'pending'
               AND inflight.lease_expires_at > ?
               AND inflight.request_id <> candidate.request_id
          )
          ORDER BY created_at ASC
          LIMIT 1`,
        [actorId, input.now, input.workflowId, input.now, input.now, input.now, input.workflowId, input.now],
      );
      const row = rows[0];
      if (!row) return null;
      const changes = await execute(
        db,
        `UPDATE generation_request
            SET status = 'pending', run_id = request_id,
                workflow_id = COALESCE(workflow_id, ?),
                max_attempts = CASE WHEN workflow_id IS NULL THEN ? ELSE max_attempts END,
                claim_owner = ?, lease_expires_at = ?,
                fencing_token = fencing_token + 1, attempt_count = attempt_count + 1,
                next_retry_at = NULL,
                phase = CASE WHEN phase IN ('publishing', 'reconciling') THEN phase ELSE 'running' END,
                phase_started_at = CASE WHEN phase IN ('publishing', 'reconciling') THEN phase_started_at ELSE ? END,
                source_cursor_before = COALESCE(source_cursor_before, (
                  SELECT prior.source_cursor_after
                    FROM generation_request AS prior
                   WHERE prior.actor_id = generation_request.actor_id
                     AND prior.workflow_id = ?
                     AND prior.phase IN ('published', 'zero_artifacts')
                     AND prior.source_cursor_after IS NOT NULL
                   ORDER BY prior.completed_at DESC, prior.request_id DESC
                   LIMIT 1
                )),
                started_at = COALESCE(started_at, ?), last_attempt_at = ?, updated_at = ?
          WHERE actor_id = ? AND request_id = ? AND fencing_token = ? AND expires_at > ?
            AND (workflow_id IS NULL OR workflow_id = ?) AND (
              (attempt_count < max_attempts AND (
                status = 'accepted'
                OR (status = 'retry_wait' AND next_retry_at <= ?)
                OR (status = 'pending' AND lease_expires_at <= ? AND phase NOT IN ('publishing', 'reconciling'))
              ))
              OR (status = 'pending' AND lease_expires_at <= ? AND phase IN ('publishing', 'reconciling'))
            )
            AND NOT EXISTS (
              SELECT 1 FROM generation_request AS inflight
               WHERE inflight.actor_id = generation_request.actor_id
                 AND inflight.workflow_id = ?
                 AND inflight.status = 'pending'
                 AND inflight.lease_expires_at > ?
                 AND inflight.request_id <> generation_request.request_id
            )`,
        [
          input.workflowId,
          input.maxAttempts,
          input.claimOwner,
          input.leaseExpiresAt,
          input.now,
          input.workflowId,
          input.now,
          input.now,
          input.now,
          actorId,
          row.request_id,
          Number(row.fencing_token ?? 0),
          input.now,
          input.workflowId,
          input.now,
          input.now,
          input.now,
          input.workflowId,
          input.now,
        ],
      );
      if (changes === 1) return this.readGenerationRequest(actor, row.request_id);
    }
    return null;
  }

  async heartbeatGenerationRequest(
    actor: FeedHostActorStorage,
    input: FeedGenerationMutationIdentity & { leaseExpiresAt: string },
  ): Promise<FeedGenerationRequestRecord> {
    await this.executeFencedMutation(
      actor,
      input,
      "SET lease_expires_at = ?, updated_at = ?",
      [input.leaseExpiresAt, input.now],
    );
    return this.requireGenerationRequest(actor, input.requestId);
  }

  async updateGenerationRequestPhase(
    actor: FeedHostActorStorage,
    input: FeedGenerationMutationIdentity & {
      phase: "running" | "validating";
      metadata: FeedGenerationMetadataPatch;
    },
  ): Promise<FeedGenerationRequestRecord> {
    const patch = generationMetadataSql(input.metadata);
    await this.executeFencedMutation(
      actor,
      input,
      `SET phase = ?, phase_started_at = ?, ${patch.setClause} updated_at = ?`,
      [input.phase, input.now, ...patch.params, input.now],
      "AND cancellation_requested = 0 AND phase NOT IN ('publishing', 'reconciling')",
    );
    return this.requireGenerationRequest(actor, input.requestId);
  }

  async publishGenerationArtifacts(
    actor: FeedHostActorStorage,
    input: FeedGenerationMutationIdentity & {
      publicationKey?: string;
      artifacts?: FeedArtifact[];
      timingEvents?: FeedGenerationTimingEvent[];
    },
  ): Promise<{
    outcome: "published" | "zero_artifacts" | "cancelled";
    request: FeedGenerationRequestRecord;
    artifactIds: string[];
    publicationKey: string | null;
  }> {
    let current = await this.requireGenerationRequest(actor, input.requestId);
    if (
      current.status === "cancelled" && current.runId === input.runId &&
      current.claimOwner === input.claimOwner && current.fencingToken === input.fencingToken
    ) {
      return { outcome: "cancelled", request: current, artifactIds: [], publicationKey: null };
    }
    current = await this.requireCurrentGenerationRun(actor, input);
    if (input.artifacts === undefined && !current.publicationManifest) {
      throw new FeedHostError("artifacts are required before publication can resume", 400, "invalid_worker_request");
    }
    const artifacts = [...(input.artifacts ?? current.publicationManifest as FeedArtifact[])]
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    const artifactIds = artifacts.map((artifact) => artifact.artifactId);
    if (new Set(artifactIds).size !== artifactIds.length) {
      throw new FeedHostError("artifact ids must be unique", 400, "invalid_worker_request");
    }
    for (const artifact of artifacts) {
      const validated = validateFeedArtifact(artifact);
      if (!validated.ok) {
        throw new FeedHostError("artifact validation failed", 400, "invalid_artifact", { errors: validated.errors });
      }
      if (artifact.producedBy.runId !== input.requestId) {
        throw new FeedHostError("artifact runId must equal requestId", 400, "invalid_artifact");
      }
      assertArtifactSourcesWereCheckpointed(artifact, current.sourceRefs);
    }
    const publicationKey = input.publicationKey ?? current.publicationKey;
    if (!publicationKey || !/^[a-z0-9][a-z0-9:._-]{0,255}$/i.test(publicationKey)) {
      throw new FeedHostError("publicationKey is required", 400, "invalid_worker_request");
    }
    if (current.publicationKey && current.publicationKey !== publicationKey) throw publicationConflict();
    if (current.artifactIds.length > 0 && !sameStrings(current.artifactIds, artifactIds)) throw publicationConflict();
    if (current.publicationManifest && stableJson(current.publicationManifest) !== stableJson(artifacts)) {
      throw publicationConflict();
    }
    const timingEvents = input.timingEvents ?? current.timingEvents;
    if (!current.publicationManifest) {
      const changes = await execute(
        this.db(actor, "feed_index"),
        `UPDATE generation_request
            SET phase = 'publishing', phase_started_at = ?, publication_key = ?,
                artifact_ids_json = ?, publication_manifest_json = ?, timing_events_json = ?, updated_at = ?
          WHERE actor_id = ? AND request_id = ? AND run_id = ? AND claim_owner = ?
            AND fencing_token = ? AND status = 'pending' AND lease_expires_at > ?
            AND cancellation_requested = 0 AND phase IN ('running', 'validating')
            AND publication_manifest_json IS NULL`,
        [
          input.now,
          publicationKey,
          JSON.stringify(artifactIds),
          stableJson(artifacts),
          JSON.stringify(timingEvents),
          input.now,
          normalizeActorId(actor.actorId),
          input.requestId,
          input.runId,
          input.claimOwner,
          input.fencingToken,
          input.now,
        ],
      );
      if (changes !== 1) {
        const after = await this.requireGenerationRequest(actor, input.requestId);
        if (
          after.status === "pending" && after.cancellationRequested &&
          after.phase !== "publishing" && after.phase !== "reconciling"
        ) {
          await this.executeFencedMutation(
            actor,
            input,
            "SET status = 'cancelled', phase = 'cancelled', completed_at = ?, updated_at = ?",
            [input.now, input.now],
            "AND cancellation_requested = 1 AND phase NOT IN ('publishing', 'reconciling')",
          );
          const cancelled = await this.requireGenerationRequest(actor, input.requestId);
          return { outcome: "cancelled", request: cancelled, artifactIds: [], publicationKey: null };
        }
        throw generationLeaseConflict();
      }
    } else if (current.phase !== "publishing" && current.phase !== "reconciling") {
      throw generationLeaseConflict();
    }
    for (const artifact of artifacts) {
      await this.writeArtifactDocument(actor, artifact);
    }
    await this.insertSeedRows(actor, "artifacts_index", artifacts.map(artifactIndexRow));
    await this.assertGenerationRequestFence(actor, input);
    const request = await this.requireGenerationRequest(actor, input.requestId);
    return {
      outcome: artifactIds.length > 0 ? "published" : "zero_artifacts",
      request,
      artifactIds,
      publicationKey,
    };
  }

  async reconcileGenerationRequest(
    actor: FeedHostActorStorage,
    input: FeedGenerationMutationIdentity,
  ): Promise<{ request: FeedGenerationRequestRecord; feedItemIds: string[] }> {
    const current = await this.requireCurrentGenerationRun(actor, input);
    if (current.phase !== "publishing" && current.phase !== "reconciling") throw generationLeaseConflict();
    if (!current.publicationKey) throw new FeedHostError("artifacts must be checkpointed before reconciliation", 409, "publication_incomplete");
    await this.executeFencedMutation(
      actor,
      input,
      "SET phase = 'reconciling', phase_started_at = ?, updated_at = ?",
      [input.now, input.now],
      "AND phase IN ('publishing', 'reconciling')",
    );
    const plan = await this.reconcileFeedProjection(actor);
    const expectedFeedItemIds = new Set(current.publicationManifest!.flatMap((value) => {
      const artifact = value as FeedArtifact;
      const mode = artifact.feedSurface?.mode;
      if (mode === "none") return [];
      const postIds = mode === "artifact_preview"
        ? []
        : postsFromArtifact(artifact).map((post) => feedItemIdForPost(artifact.artifactId, post.postId));
      return [...postIds, `legacy:${artifact.artifactId}`];
    }));
    const expectedArtifacts = new Set(current.artifactIds);
    const actualFeedItemIds = new Set(plan.desired
      .filter((item) => expectedArtifacts.has(item.target.artifactId))
      .map((item) => item.feedItemId));
    if (!sameStrings([...expectedFeedItemIds], [...actualFeedItemIds])) {
      throw new FeedHostError("Feed reconciliation is incomplete", 409, "publication_incomplete");
    }
    const timingEvents = [
      ...current.timingEvents.filter((event) => event.name !== "feed_reconciled"),
      { name: "feed_reconciled", at: input.now },
    ];
    await this.executeFencedMutation(
      actor,
      input,
      "SET timing_events_json = ?, updated_at = ?",
      [JSON.stringify(timingEvents), input.now],
      "AND phase = 'reconciling'",
    );
    const feedItemIds = [...actualFeedItemIds].sort();
    return { request: await this.requireGenerationRequest(actor, input.requestId), feedItemIds };
  }

  async completeGenerationRequest(
    actor: FeedHostActorStorage,
    input: FeedGenerationMutationIdentity & {
      outcome: "published" | "zero_artifacts";
      cursor: unknown;
      artifactIds: string[];
      timingEvents?: FeedGenerationTimingEvent[];
    },
  ): Promise<FeedGenerationRequestRecord> {
    const current = await this.requireCurrentGenerationRun(actor, input);
    if (current.phase !== "reconciling") throw generationLeaseConflict();
    if (!sameStrings(current.artifactIds, input.artifactIds)) throw publicationConflict();
    if ((input.outcome === "published") !== (input.artifactIds.length > 0)) {
      throw new FeedHostError("terminal outcome does not match artifact ids", 400, "invalid_worker_request");
    }
    await this.executeFencedMutation(
      actor,
      input,
      "SET status = 'consumed', phase = ?, source_cursor_after = ?, completed_at = ?, timing_events_json = ?, lease_expires_at = NULL, updated_at = ?",
      [
        input.outcome,
        JSON.stringify(input.cursor),
        input.now,
        JSON.stringify(input.timingEvents ?? current.timingEvents),
        input.now,
      ],
      "AND phase = 'reconciling'",
    );
    return this.requireGenerationRequest(actor, input.requestId);
  }

  async retryGenerationRequest(
    actor: FeedHostActorStorage,
    input: FeedGenerationMutationIdentity & {
      nextRetryAt: string;
      retryable?: boolean;
      error: { code: string; message?: string };
      timingEvents?: FeedGenerationTimingEvent[];
    },
  ): Promise<FeedGenerationRequestRecord> {
    await this.executeFencedMutation(
      actor,
      input,
           `SET status = CASE
             WHEN cancellation_requested = 1 THEN 'cancelled'
             WHEN ? = 0 THEN 'dead_letter'
             WHEN attempt_count >= max_attempts THEN 'dead_letter'
             ELSE 'retry_wait'
           END,
           phase = CASE
             WHEN cancellation_requested = 1 THEN 'cancelled'
             WHEN ? = 0 THEN 'dead_letter'
             WHEN attempt_count >= max_attempts THEN 'dead_letter'
             ELSE 'retry_wait'
           END,
           next_retry_at = CASE
             WHEN ? = 1 AND cancellation_requested = 0 AND attempt_count < max_attempts THEN ?
             ELSE NULL
           END,
           lease_expires_at = NULL, error_json = ?, timing_events_json = ?,
           completed_at = CASE WHEN cancellation_requested = 1 OR ? = 0 OR attempt_count >= max_attempts THEN ? ELSE NULL END,
           updated_at = ?`,
      [
        input.retryable === false ? 0 : 1,
        input.retryable === false ? 0 : 1,
        input.retryable === false ? 0 : 1,
        input.nextRetryAt,
        JSON.stringify(input.error),
        JSON.stringify(input.timingEvents ?? []),
        input.retryable === false ? 0 : 1,
        input.now,
        input.now,
      ],
      "AND phase NOT IN ('publishing', 'reconciling')",
    );
    return this.requireGenerationRequest(actor, input.requestId);
  }

  async requestGenerationCancellation(
    actor: FeedHostActorStorage,
    input: { requestId: string; now: string },
  ): Promise<FeedGenerationRequestRecord> {
    const actorId = normalizeActorId(actor.actorId);
    const changes = await execute(
      this.db(actor, "feed_index"),
      `UPDATE generation_request
          SET cancellation_requested = 1,
              status = CASE
                WHEN status IN ('accepted', 'retry_wait') OR (status = 'pending' AND phase NOT IN ('publishing', 'reconciling'))
                  THEN 'cancelled'
                ELSE status
              END,
              phase = CASE
                WHEN status IN ('accepted', 'retry_wait') OR (status = 'pending' AND phase NOT IN ('publishing', 'reconciling'))
                  THEN 'cancelled'
                ELSE phase
              END,
              completed_at = CASE
                WHEN status IN ('accepted', 'retry_wait') OR (status = 'pending' AND phase NOT IN ('publishing', 'reconciling'))
                  THEN ?
                ELSE completed_at
              END,
              updated_at = ?
        WHERE actor_id = ? AND request_id = ?
          AND status NOT IN ('consumed', 'cancelled', 'dead_letter', 'rejected', 'expired')`,
      [input.now, input.now, actorId, input.requestId],
    );
    if (changes === 0) return this.requireGenerationRequest(actor, input.requestId);
    return this.requireGenerationRequest(actor, input.requestId);
  }

  private async executeFencedMutation(
    actor: FeedHostActorStorage,
    input: FeedGenerationMutationIdentity,
    setClause: string,
    params: SqlValue[],
    extraGuard = "",
    extraGuardParams: SqlValue[] = [],
  ): Promise<void> {
    const changes = await execute(
      this.db(actor, "feed_index"),
      `UPDATE generation_request ${setClause}
        WHERE actor_id = ? AND request_id = ? AND run_id = ? AND claim_owner = ?
          AND fencing_token = ? AND status = 'pending' AND lease_expires_at > ? ${extraGuard}`,
      [
        ...params,
        normalizeActorId(actor.actorId),
        input.requestId,
        input.runId,
        input.claimOwner,
        input.fencingToken,
        input.now,
        ...extraGuardParams,
      ],
    );
    if (changes !== 1) throw generationLeaseConflict();
  }

  async assertGenerationRequestFence(
    actor: FeedHostActorStorage,
    input: FeedGenerationMutationIdentity,
  ): Promise<FeedGenerationRequestRecord> {
    return this.requireCurrentGenerationRun(actor, input);
  }

  private async readGenerationRequest(
    actor: FeedHostActorStorage,
    requestId: string,
  ): Promise<FeedGenerationRequestRecord | null> {
    const rows = await queryRows<GenerationRequestRow>(
      this.db(actor, "feed_index"),
      `SELECT ${GENERATION_REQUEST_COLUMNS}
         FROM generation_request
        WHERE actor_id = ? AND request_id = ?
        LIMIT 1`,
      [normalizeActorId(actor.actorId), requestId],
    );
    return rows[0] ? generationRequestFromRow(rows[0]) : null;
  }

  private async requireGenerationRequest(
    actor: FeedHostActorStorage,
    requestId: string,
  ): Promise<FeedGenerationRequestRecord> {
    const request = await this.readGenerationRequest(actor, requestId);
    if (!request) throw new FeedHostError(`generation request not found: ${requestId}`, 404, "not_found");
    return request;
  }

  private async requireCurrentGenerationRun(
    actor: FeedHostActorStorage,
    input: FeedGenerationMutationIdentity,
  ): Promise<FeedGenerationRequestRecord> {
    const request = await this.requireGenerationRequest(actor, input.requestId);
    if (
      request.status !== "pending" ||
      request.runId !== input.runId ||
      request.claimOwner !== input.claimOwner ||
      request.fencingToken !== input.fencingToken ||
      !request.leaseExpiresAt ||
      request.leaseExpiresAt <= input.now
    ) {
      throw generationLeaseConflict();
    }
    return request;
  }

  async updateGenerationRequestStatus(
    actor: FeedHostActorStorage,
    input: {
      requestId: string;
      status: FeedGenerationRequestRecord["status"];
      expectedStatus?: FeedGenerationRequestRecord["status"];
      updatedAt: string;
    },
  ): Promise<FeedGenerationRequestRecord> {
    const normalizedActorId = normalizeActorId(actor.actorId);
    const rows = await queryRows<GenerationRequestRow>(
      this.db(actor, "feed_index"),
      `SELECT ${GENERATION_REQUEST_COLUMNS}
         FROM generation_request
        WHERE actor_id = ? AND request_id = ?
        LIMIT 1`,
      [normalizedActorId, input.requestId],
    );
    const row = rows[0];
    if (!row) {
      throw new FeedHostError(`generation request not found: ${input.requestId}`, 404, "not_found");
    }
    if (input.expectedStatus !== undefined && row.status !== input.expectedStatus) {
      throw new FeedHostError(
        `generation request status is ${row.status}, expected ${input.expectedStatus}`,
        409,
        "status_conflict",
      );
    }
    await batch(this.db(actor, "feed_index"), [
      {
        sql: `UPDATE generation_request SET status = ?, updated_at = ? WHERE actor_id = ? AND request_id = ?`,
        params: [input.status, input.updatedAt, normalizedActorId, input.requestId],
      },
    ]);
    return generationRequestFromRow({ ...row, status: input.status, updated_at: input.updatedAt });
  }

  async listSkills(
    actor: FeedHostActorStorage,
    input: { actorId: string; limit: number; cursor?: string },
  ): Promise<{ items: FeedHostSkillState[]; nextCursor?: string }> {
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new FeedHostError("cursor must be a non-negative integer offset", 400, "bad_request");
    }
    const limit = Math.max(1, Math.min(input.limit, 100));
    const normalizedActorId = normalizeActorId(input.actorId);
    let rows: SkillCredentialsRow[];
    try {
      rows = await queryRows<SkillCredentialsRow>(
        this.db(actor, "feed_index"),
        `SELECT profile_id, scope, value_json, version, updated_at
           FROM preference_profile
          WHERE actor_id = ? AND scope LIKE ?
          ORDER BY updated_at DESC, profile_id DESC
          LIMIT ? OFFSET ?`,
        [normalizedActorId, "skill:%:credentials", limit + 1, offset],
      );
    } catch {
      // Redact the underlying SQL error so quoted params/values (which can
      // include an actor's raw secretRef payload if a lookup ever races a
      // patch) never surface in HTTP error bodies.
      throw new FeedHostError("skill credential listing failed", 500, "internal_error");
    }
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map((row) => toWireSkillState(skillRecordFromRow(row))),
      nextCursor: rows.length > limit ? String(offset + limit) : undefined,
    };
  }

  // Redacted routine read model for workflow controls (TC-182): joins package
  // state, the actor's package preferences (paused/disabled/cadence), the
  // latest run summary, and the latest published post example. Raw authority
  // material (digests, manifest/workflow refs, budget ids) never leaves here —
  // it stays available for a future advanced-diagnostics surface.
  async listWorkflows(
    actor: FeedHostActorStorage,
    input: { actorId: string; limit: number; cursor?: string },
  ): Promise<{ items: FeedHostWorkflowState[]; nextCursor?: string }> {
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new FeedHostError("cursor must be a non-negative integer offset", 400, "bad_request");
    }
    const limit = Math.max(1, Math.min(input.limit, 100));
    const packages = await queryRows<WorkflowPackageStateRow>(
      this.db(actor, "artifacts_index"),
      `SELECT package_id, display_name, version, admission_state, disclosure_json, enabled_at, paused_at, updated_at
         FROM workflow_package_state
        ORDER BY display_name ASC, package_id ASC
        LIMIT ? OFFSET ?`,
      [limit + 1, offset],
    );
    const pagePackages = packages.slice(0, limit);
    if (pagePackages.length === 0) {
      return { items: [], nextCursor: undefined };
    }
    const packageIds = pagePackages.map((row) => row.package_id);
    const placeholders = packageIds.map(() => "?").join(", ");

    const runRows = await queryRows<WorkflowRunIndexRow>(
      this.db(actor, "artifacts_index"),
      `SELECT run_id, package_id, status, published_artifact_ids_json, error_json, started_at, finished_at
         FROM workflow_run_index
        WHERE package_id IN (${placeholders})
        ORDER BY started_at DESC
        LIMIT 200`,
      packageIds,
    );
    const latestRunByPackage = new Map<string, WorkflowRunIndexRow>();
    for (const run of runRows) {
      if (!latestRunByPackage.has(run.package_id)) latestRunByPackage.set(run.package_id, run);
    }

    // feed_item_projection carries no post title (see FEED_V1 schema); the
    // example is a "there is a recent ranked output" signal — artifact id +
    // date. Titles for reviewed starters come from presentation.exampleTitles.
    const exampleRows = await queryRows<WorkflowExampleRow>(
      this.db(actor, "feed_index"),
      `SELECT artifact_id, package_id, published_at
         FROM feed_item_projection
        WHERE package_id IN (${placeholders}) AND visibility = 'ranked'
        ORDER BY published_at DESC
        LIMIT 200`,
      packageIds,
    );
    const exampleByPackage = new Map<string, WorkflowExampleRow>();
    for (const example of exampleRows) {
      if (!exampleByPackage.has(example.package_id)) exampleByPackage.set(example.package_id, example);
    }

    const normalizedActorId = normalizeActorId(input.actorId);
    const scopes = packageIds.map((packageId) => `package:${packageId}`);
    const scopePlaceholders = scopes.map(() => "?").join(", ");
    const preferenceRows = await queryRows<{ scope: string; value_json: string; version: number }>(
      this.db(actor, "feed_index"),
      `SELECT scope, value_json, version FROM preference_profile WHERE actor_id = ? AND scope IN (${scopePlaceholders})`,
      [normalizedActorId, ...scopes],
    );
    const preferenceByPackage = new Map<string, { value: FeedPreferenceValue; version: number }>();
    for (const row of preferenceRows) {
      const packageId = row.scope.slice("package:".length);
      preferenceByPackage.set(packageId, { value: parsePreferenceValueJson(row.value_json), version: Number(row.version) });
    }

    return {
      items: pagePackages.map((row) =>
        toWireWorkflowState(row, latestRunByPackage.get(row.package_id), exampleByPackage.get(row.package_id), preferenceByPackage.get(row.package_id)),
      ),
      nextCursor: packages.length > limit ? String(offset + limit) : undefined,
    };
  }

  async upsertSkillCredentials(
    actor: FeedHostActorStorage,
    input: { actorId: string; skillId: string; patch: FeedHostSkillCredentialsPatch },
  ): Promise<FeedHostSkillState> {
    const skillId = input.skillId.trim();
    if (!skillId) throw new FeedHostError("skillId is required", 400, "bad_request");
    if (!isSupportedCredentialMode(input.patch.credentialMode)) {
      throw new FeedHostError("credentialMode is not allowlisted", 400, "invalid_mode");
    }
    const scope = skillCredentialsScope(skillId);
    const normalizedActorId = normalizeActorId(input.actorId);

    let existing: SkillCredentialsRow[];
    try {
      existing = await queryRows<SkillCredentialsRow>(
        this.db(actor, "feed_index"),
        `SELECT profile_id, scope, value_json, version, updated_at
           FROM preference_profile
          WHERE actor_id = ? AND scope = ?
          LIMIT 1`,
        [normalizedActorId, scope],
      );
    } catch {
      throw new FeedHostError("skill credential lookup failed", 500, "internal_error");
    }
    const current = existing[0] ? skillRecordFromRow(existing[0]) : null;
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== input.patch.expectedVersion) {
      throw new FeedHostError("skill credential version conflict", 409, "version_conflict", { currentVersion });
    }

    const next = mergeSkillState(skillId, current, input.patch);
    const profileId = skillProfileId(normalizedActorId, skillId);
    const nextValue: StoredSkillCredentialsValue = {
      skillId: next.skillId,
      credentialMode: next.credentialMode,
      providerId: next.providerId,
      secretRef: next.secretRef,
      budget: {
        budgetId: next.budget.budgetId,
        limit: next.budget.limit,
        spent: next.budget.spent,
        currency: next.budget.currency,
        disabled: next.budget.disabled,
      },
    };
    let changes: number;
    try {
      changes = await execute(
        this.db(actor, "feed_index"),
        `INSERT INTO preference_profile (
          profile_id, actor_id, scope, value_json, version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
          actor_id = excluded.actor_id,
          scope = excluded.scope,
          value_json = excluded.value_json,
          version = excluded.version,
          updated_at = excluded.updated_at
        WHERE preference_profile.version = ?`,
        [
          profileId,
          normalizedActorId,
          scope,
          JSON.stringify(nextValue),
          next.version,
          next.updatedAt,
          currentVersion,
        ],
      );
    } catch {
      throw new FeedHostError("skill credential update failed", 500, "internal_error");
    }
    if (changes === 0) {
      throw new FeedHostError("skill credential version conflict", 409, "version_conflict", { currentVersion });
    }
    return toWireSkillState(next);
  }



  async listFeedEvents(actor: FeedHostActorStorage, afterEventId?: string): Promise<string> {
    const projections = await this.readCachedProjectionStates(actor);
    return renderFeedEventStream(filterFeedEventsAfterId(buildFeedEvents({ projections }), afterEventId));
  }

  async debugState(actor: FeedHostActorStorage): Promise<{
    artifacts: number;
    projections: number;
    feedback: number;
    preferences: number;
    controlIntents: number;
    generationRequests: number;
  }> {
    const [artifacts, projections, feedback, preferences, controlIntents, generationRequests] = await Promise.all([
      count(this.db(actor, "artifacts_index"), "artifact_index"),
      count(this.db(actor, "feed_index"), "feed_item_projection"),
      count(this.db(actor, "feed_index"), "feedback_event"),
      count(this.db(actor, "feed_index"), "preference_profile"),
      count(this.db(actor, "feed_index"), "control_intent_event"),
      count(this.db(actor, "feed_index"), "generation_request"),
    ]);
    return { artifacts, projections, feedback, preferences, controlIntents, generationRequests };
  }

  private db(actor: FeedHostActorStorage, dbName: FeedV1SqlResourceName): IDatabaseHandle {
    const access = dbName === "artifacts_index" ? actor.artifacts : actor.feed;
    return access.sql.db(DB_PATHS[dbName]);
  }

  private async readProjectionStates(
    actor: FeedHostActorStorage,
    knownArtifacts?: readonly ArtifactIndexRow[],
  ): Promise<FeedProjectionState[]> {
    // Keep resource calls sequential. Some TinyCloud access handles serialize
    // invocations, so overlapping feed/artifact DB reads can stall activation.
    const artifacts = knownArtifacts ?? await this.readArtifactIndexRows(actor);
    const rows = await queryRows<Omit<ProjectionRow, "artifact_type">>(
      this.db(actor, "feed_index"),
      `SELECT feed_item_id, target_kind, artifact_id, post_id,
              rank_score, disposition, visibility, freshness_label, reason_codes_json,
              package_id, source_fingerprint, published_at, updated_at
         FROM feed_item_projection
        ORDER BY published_at DESC, feed_item_id ASC`,
    );
    const artifactTypes = new Map(artifacts.map((row) => [row.artifact_id, row.artifact_type] as const));
    return rows.flatMap((row) => {
      const artifactType = artifactTypes.get(row.artifact_id);
      return artifactType ? [projectionStateFromRow({ ...row, artifact_type: artifactType })] : [];
    });
  }

  private async readCachedProjectionStates(actor: FeedHostActorStorage): Promise<FeedProjectionState[]> {
    const key = storageCacheKey(actor);
    const cached = this.projectionCache.get(key);
    if (cached) return cached;
    const projections = await this.readProjectionStates(actor);
    this.projectionCache.set(key, projections);
    return projections;
  }

  private async readArtifactIndexRows(actor: FeedHostActorStorage): Promise<ArtifactIndexRow[]> {
    return queryRows<ArtifactIndexRow>(
      this.db(actor, "artifacts_index"),
      `SELECT artifact_id, artifact_type, package_id, source_fingerprint, doc_key, published_at, updated_at
         FROM artifact_index
        ORDER BY published_at ASC, artifact_id ASC`,
    );
  }

  private async readFeedbackRows(actor: FeedHostActorStorage): Promise<FeedbackRow[]> {
    const rows = await queryRows<FeedbackDbRow>(
      this.db(actor, "feed_index"),
      `SELECT event_id AS eventId, target_kind AS targetKind, artifact_id AS artifactId,
              post_id AS postId, feed_item_id AS feedItemId, signal, created_at AS createdAt
         FROM feed_targeted_interaction_event
        WHERE actor_id = ?
        UNION ALL
       SELECT f.event_id AS eventId, 'artifact' AS targetKind, f.artifact_id AS artifactId,
              NULL AS postId, NULL AS feedItemId, f.signal, f.created_at AS createdAt
         FROM feedback_event AS f
        WHERE f.actor_id = ?
          AND NOT EXISTS (SELECT 1 FROM feed_targeted_interaction_event AS t WHERE t.event_id = f.event_id)
        ORDER BY createdAt ASC`,
      [normalizeActorId(actor.actorId), normalizeActorId(actor.actorId)],
    );
    return rows.map((row) => ({
      target: interactionTargetFromRow(row),
      signal: row.signal,
      createdAt: row.createdAt,
    }));
  }

  private async readCachedFeedbackRows(actor: FeedHostActorStorage): Promise<FeedbackRow[]> {
    const key = storageCacheKey(actor);
    const cached = this.feedbackCache.get(key);
    if (cached) return cached;
    const rows = await this.readFeedbackRows(actor);
    this.feedbackCache.set(key, rows);
    return rows;
  }

  private async readCachedPreferenceProfiles(actor: FeedHostActorStorage): Promise<FeedPreferenceProfileRecord[]> {
    const key = storageCacheKey(actor);
    const cached = this.preferenceCache.get(key);
    if (cached) return cached;
    const rows = await this.listPreferenceProfiles(actor);
    this.preferenceCache.set(key, rows);
    return rows;
  }

  private async readArtifactDocument(
    actor: FeedHostActorStorage,
    docKey: string,
  ): Promise<
    | { kind: "found"; artifact: FeedArtifact }
    | { kind: "not_found" }
    | { kind: "malformed"; docKey: string; error: string }
    | { kind: "schema_mismatch"; docKey: string; errors: string[] }
  > {
    const result = await actor.documents.kv.get<FeedArtifact | string>(artifactDocKey(docKey));
    if (!result.ok) {
      if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") return { kind: "not_found" };
      throw new Error(`Failed to read artifact document: ${resultError(result)}`);
    }
    const hydrated = hydrateArtifactDocument(result.data.data);
    if (hydrated.kind === "malformed") return { kind: "malformed", docKey, error: hydrated.error };
    if (hydrated.kind === "schema_mismatch") return { kind: "schema_mismatch", docKey, errors: hydrated.errors };
    return hydrated;
  }

  private async readProjectionTarget(
    actor: FeedHostActorStorage,
    target: FeedInteractionTarget,
  ): Promise<{ package_id: string } | null> {
    if (target.kind === "artifact") {
      const rows = await queryRows<{ package_id: string }>(
        this.db(actor, "artifacts_index"),
        "SELECT package_id FROM artifact_index WHERE artifact_id = ? LIMIT 1",
        [target.artifactId],
      );
      return rows[0] ?? null;
    }
    const rows = await queryRows<{ package_id: string }>(
      this.db(actor, "feed_index"),
      target.kind === "feed_item"
        ? `SELECT package_id FROM feed_item_projection WHERE feed_item_id = ? LIMIT 1`
        : `SELECT package_id FROM feed_item_projection WHERE target_kind = 'post' AND artifact_id = ? AND post_id = ? LIMIT 1`,
      target.kind === "feed_item"
        ? [target.feedItemId]
        : [target.artifactId, target.postId],
    );
    return rows[0] ?? null;
  }

  private async readPreferenceProfileByActor(
    actor: FeedHostActorStorage,
    actorId: string,
    scope: string,
  ): Promise<FeedPreferenceProfileRecord | null> {
    const rows = await queryRows<PreferenceRow>(
      this.db(actor, "feed_index"),
      "SELECT profile_id, actor_id, scope, value_json, version, updated_at FROM preference_profile WHERE actor_id = ? AND scope = ?",
      [normalizeActorId(actorId), scope],
    );
    const row = rows[0];
    return row ? preferenceRecordFromRow(row) : null;
  }

  private async writePreferenceProfileRecord(actor: FeedHostActorStorage, record: FeedPreferenceProfileRecord): Promise<void> {
    await batch(this.db(actor, "feed_index"), [
      {
        sql: `INSERT OR REPLACE INTO preference_profile (
          profile_id, actor_id, scope, value_json, version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        params: [record.profileId, record.actorId, record.scope, JSON.stringify(record.value), record.version, record.updatedAt],
      },
    ]);
    this.preferenceCache.delete(storageCacheKey(actor));
    const result = await actor.settings.kv.put(preferenceKey(record.actorId, record.scope), record, {
      contentType: "application/json",
    });
    if (!result.ok) throw new Error(`Failed to persist preference profile: ${resultError(result)}`);
  }

  private async bumpShowFewerPreference(actor: FeedHostActorStorage, actorId: string, packageId: string, updatedAt: string): Promise<void> {
    const scope = FEED_HOST_PREFERENCES_SCOPE;
    const current = await this.readPreferenceProfileByActor(actor, actorId, scope);
    const next = current?.value ? mergePreferencePatch(defaultPreferenceValue(), current.value) : defaultPreferenceValue();
    const counts = { ...(next.showFewerPackageIds ?? {}) };
    counts[packageId] = (counts[packageId] ?? 0) + 1;
    next.showFewerPackageIds = counts;
    await this.writePreferenceProfileRecord(actor, {
      profileId: preferenceProfileId(actorId, scope),
      actorId,
      scope,
      value: next,
      version: (current?.version ?? 0) + 1,
      updatedAt,
    });
  }

  private async findFeedbackEvent(actor: FeedHostActorStorage, actorId: string, readerNonce: string): Promise<{ eventId: string } | null> {
    const rows = await queryRows<{ eventId: string }>(
      this.db(actor, "feed_index"),
      `SELECT event_id AS eventId FROM feed_targeted_interaction_event WHERE actor_id = ? AND reader_nonce = ?
       UNION ALL
       SELECT event_id AS eventId FROM feedback_event WHERE actor_id = ? AND reader_nonce = ?
       LIMIT 1`,
      [actorId, readerNonce, actorId, readerNonce],
    );
    return rows[0] ?? null;
  }

  private async findControlIntent(actor: FeedHostActorStorage, actorId: string, readerNonce: string): Promise<ControlIntentRow | null> {
    const rows = await queryRows<ControlIntentRow>(
      this.db(actor, "feed_index"),
      `SELECT event_id, reader_nonce, actor_id, intent_kind, status, target_ref, payload_hash, payload_json, created_at
         FROM control_intent_event
        WHERE actor_id = ? AND reader_nonce = ?`,
      [actorId, readerNonce],
    );
    return rows[0] ?? null;
  }

  private async findGenerationRequestId(actor: FeedHostActorStorage, actorId: string, readerNonce: string): Promise<string | undefined> {
    const rows = await queryRows<{ request_id: string }>(
      this.db(actor, "feed_index"),
      `SELECT request_id
         FROM generation_request
        WHERE actor_id = ? AND reader_nonce = ?`,
      [actorId, readerNonce],
    );
    return rows[0]?.request_id;
  }

  private async applyControlIntentEffect(
    actor: FeedHostActorStorage,
    event: FeedControlIntentInput & { actorId: string; payloadHash: string },
  ): Promise<{
    status: string;
    requestId?: string;
    generationRequestStatement?: SqlStatement;
    error?: FeedHostError;
  }> {
    const payload = plainObjectOrUndefined(event.payload);
    try {
      switch (event.intentKind) {
        case "set_saved":
        case "set_artifact_visibility": {
          const desiredDisposition =
            event.intentKind === "set_saved"
              ? payload?.saved === false || payload?.state === "unsaved"
                ? "default"
                : "saved"
              : payload?.visibility === "hidden" || payload?.hidden === true || payload?.state === "hidden"
                ? "hidden"
                : "default";
          await this.updateProjectionDisposition(actor, event.targetRef, desiredDisposition, event.createdAt);
          return { status: "applied" };
        }
        case "adjust_preference":
        case "set_cadence":
        case "safe_package_setting_update":
        case "candidate_package_proposal":
        case "enable_package":
        case "pause_package":
        case "disable_package":
        case "tune_package":
        case "reset_package":
        case "reset_preferences": {
          const scope = preferenceScopeForIntent(event.intentKind, payload, event.targetRef);
          if (event.intentKind === "reset_preferences" || event.intentKind === "reset_package") {
            const current = await this.readPreferenceProfileByActor(actor, event.actorId, scope);
            const currentVersion = current?.version ?? 0;
            const expectedVersion =
              typeof payload?.version === "number"
                ? payload.version
                : typeof payload?.expectedVersion === "number"
                  ? payload.expectedVersion
                  : currentVersion;
            if (current ? expectedVersion !== currentVersion : expectedVersion !== 0) {
              throw new FeedHostError("preference version conflict", 409, "version_conflict", { currentVersion });
            }
            await this.writePreferenceProfileRecord(actor, {
              profileId: preferenceProfileId(event.actorId, scope),
              actorId: event.actorId,
              scope,
              value: scope === FEED_HOST_PREFERENCES_SCOPE ? defaultPreferenceValue() : {},
              version: currentVersion + 1,
              updatedAt: event.createdAt,
            });
            return { status: "applied" };
          }
          const current = await this.readPreferenceProfileByActor(actor, event.actorId, scope);
          const version = typeof payload?.version === "number" ? payload.version : typeof payload?.expectedVersion === "number" ? payload.expectedVersion : current?.version ?? 0;
          const patch = controlIntentPreferencePatch(event.intentKind, payload, event.targetRef);
          const record = await this.putPreferenceProfile(actor, {
            actorId: event.actorId,
            scope,
            expectedVersion: version,
            patch,
            updatedAt: event.createdAt,
          });
          if (event.intentKind === "candidate_package_proposal") {
            return { status: "accepted" };
          }
          return { status: "applied" };
        }
        case "generate_new_request": {
          const request = await this.upsertGenerationRequest(actor, {
            actorId: event.actorId,
            readerNonce: event.readerNonce,
            eventId: event.eventId,
            createdAt: event.createdAt,
            payload,
            targetRef: event.targetRef,
            payloadHash: event.payloadHash,
          });
          return {
            status: "accepted",
            requestId: request.requestId,
            generationRequestStatement: generationRequestSql(request),
          };
        }
        default:
          return { status: "noop" };
      }
    } catch (error) {
      if (error instanceof FeedHostError) return { status: error.code, error };
      throw error;
    }
  }

  private async updateProjectionDisposition(
    actor: FeedHostActorStorage,
    artifactId: string,
    disposition: FeedArtifactProjection["disposition"],
    updatedAt: string,
  ): Promise<void> {
    await batch(this.db(actor, "feed_index"), [
      {
        sql: `UPDATE feed_item_projection SET disposition = ?, updated_at = ? WHERE artifact_id = ?`,
        params: [disposition, updatedAt, artifactId],
      },
    ]);
    this.projectionCache.delete(storageCacheKey(actor));
  }

  private async upsertGenerationRequest(
    actor: FeedHostActorStorage,
    input: {
      actorId: string;
      readerNonce: string;
      eventId: string;
      createdAt: string;
      payload: Record<string, unknown> | undefined;
      targetRef: string;
      payloadHash?: string | null;
    },
  ): Promise<FeedGenerationRequestRecord> {
    const scope = generationScopeFromPayload(input.payload, input.targetRef);
    const prompt = promptFromPayload(input.payload);
    const dedupeKey = input.payloadHash ?? hashJson({ actorId: input.actorId, scope, prompt, targetRef: input.targetRef });
    const existing = await queryRows<GenerationRequestRow>(
      this.db(actor, "feed_index"),
      `SELECT ${GENERATION_REQUEST_COLUMNS}
         FROM generation_request
        WHERE actor_id = ? AND (reader_nonce = ? OR dedupe_key = ?)
        LIMIT 1`,
      [input.actorId, input.readerNonce, dedupeKey],
    );
    const row = existing[0];
    if (row) return generationRequestFromRow(row);
    const pending = await queryRows<{ pending_count: number }>(
      this.db(actor, "feed_index"),
      `SELECT COUNT(*) AS pending_count
         FROM generation_request
        WHERE actor_id = ? AND status IN ('accepted', 'pending') AND expires_at > ?`,
      [input.actorId, input.createdAt],
    );
    const pendingCount = Number(pending[0]?.pending_count ?? 0);
    if (pendingCount >= this.maxPendingGenerationRequests) {
      throw new FeedHostError(
        `generation backlog is full (${pendingCount} pending); retry after requests complete`,
        429,
        "generation_backlog_full",
        { pendingCount, limit: this.maxPendingGenerationRequests },
      );
    }
    const expiresAt = new Date(Date.parse(input.createdAt) + 24 * 60 * 60 * 1000).toISOString();
    return {
      requestId: input.eventId,
      readerNonce: input.readerNonce,
      actorId: input.actorId,
      status: "accepted",
      scope,
      packageId: scope.packageId ?? null,
      dedupeKey,
      prompt,
      runId: null,
      workflowId: null,
      maxAttempts: 3,
      claimOwner: null,
      leaseExpiresAt: null,
      fencingToken: 0,
      attemptCount: 0,
      nextRetryAt: null,
      cancellationRequested: false,
      phase: "queued",
      phaseStartedAt: null,
      startedAt: null,
      completedAt: null,
      lastAttemptAt: null,
      sourceCursorBefore: null,
      sourceCursorAfter: null,
      sourceRefs: [],
      publicationKey: null,
      artifactIds: [],
      publicationManifest: null,
      error: null,
      timingEvents: [],
      expiresAt,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
  }

  private async performLegacyMigration(actor: FeedHostActorStorage): Promise<FeedV1MigrationSummary> {
    const [legacyArtifacts, legacyInteractions] = await Promise.all([
      readLegacyRows(actor.legacyArtifacts, LEGACY_FEED_DB_PATH, "artifact"),
      readLegacyRows(actor.legacyInteractions, LEGACY_INTERACTIONS_DB_PATH, "interaction"),
    ]);
    if (legacyArtifacts.length === 0 && legacyInteractions.length === 0) return emptyMigrationSummary();

    const plan = buildFeedV1MigrationPlan({ legacyArtifacts, legacyInteractions });
    const storage = this;
    await applyFeedV1MigrationPlan(plan, {
      writeSqlRows: async (dbName, rows) => {
        await storage.insertSeedRows(actor, dbName, rows);
      },
      writeArtifactDocument: async (artifact) => {
        await storage.writeArtifactDocument(actor, artifact);
      },
    });
    return plan.summary;
  }
}

type MigrationApplyInput = {
  namespace: string;
  migrations: Array<{ id: string; sql: string[] }>;
};

async function applyMigrations(
  db: IDatabaseHandle,
  input: MigrationApplyInput,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const candidate = db as IDatabaseHandle & {
    migrations?: { apply(input: MigrationApplyInput): Promise<{ ok: boolean; error?: unknown }> };
  };
  if (candidate.migrations?.apply) {
    const result = await candidate.migrations.apply(input).catch((error) => ({ ok: false, error }));
    if (result.ok) return { ok: true };
    if (!multiResourceInvocationUnsupported(resultError(result)) && !isDuplicateColumn(result.error)) {
      return { ok: false, error: result.error };
    }
  }

  for (const migration of input.migrations) {
    const batched = await db.batch(migration.sql.map((sql) => ({ sql }))).catch((error) => ({ ok: false as const, error }));
    if (batched.ok) continue;
    if (!multiResourceInvocationUnsupported(resultError(batched)) && !isDuplicateColumn(batched.error)) {
      return { ok: false, error: batched.error };
    }
    for (const sql of migration.sql) {
      const result = await db.execute(sql).catch((error) => ({ ok: false as const, error }));
      if (!result.ok && !isDuplicateColumn(result.error)) return { ok: false, error: result.error };
    }
  }
  return { ok: true };
}

async function queryRows<T extends Record<string, unknown>>(
  db: IDatabaseHandle,
  sql: string,
  params: SqlValue[] = [],
): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  if (!result.ok) throw new Error(`TinyCloud SQL query failed: ${resultError(result)}`);
  return responseRows<T>(result.data);
}

async function batch(db: IDatabaseHandle, statements: SqlStatement[]): Promise<void> {
  const result = await db.batch(statements);
  if (!result.ok) throw new Error(`TinyCloud SQL batch failed: ${resultError(result)}`);
}

async function execute(db: IDatabaseHandle, sql: string, params: SqlValue[] = []): Promise<number> {
  const result = await db.execute(sql, params);
  if (!result.ok) throw new Error(`TinyCloud SQL execute failed: ${resultError(result)}`);
  return Number(result.data?.changes ?? 0);
}

function skillCredentialsScope(skillId: string): string {
  return `skill:${skillId}:credentials`;
}

function skillProfileId(actorId: string, skillId: string): string {
  return `${actorId}:${skillCredentialsScope(skillId)}`;
}

function isSupportedCredentialMode(value: CredentialMode): boolean {
  return (
    value === "feed_hosted" ||
    value === "user_byok_api_key" ||
    value === "user_oauth_token" ||
    value === "none"
  );
}

function credentialModeFromValue(value: unknown): CredentialMode {
  if (
    value === "feed_hosted" ||
    value === "user_byok_api_key" ||
    value === "user_oauth_token" ||
    value === "none"
  ) {
    return value;
  }
  return "none";
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseStoredSkillValue(valueJson: string, scope: string): StoredSkillCredentialsValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson) as unknown;
  } catch {
    parsed = {};
  }
  const record =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const skillId = stringFromRecord(record, "skillId") ?? scope.replace(/^skill:/, "").replace(/:credentials$/, "");
  const budgetRecord =
    record.budget && typeof record.budget === "object" && !Array.isArray(record.budget)
      ? (record.budget as Record<string, unknown>)
      : undefined;
  return {
    skillId,
    credentialMode: credentialModeFromValue(record.credentialMode),
    providerId: stringFromRecord(record, "providerId"),
    secretRef: stringFromRecord(record, "secretRef"),
    budget: budgetRecord
      ? {
          budgetId: stringFromRecord(budgetRecord, "budgetId") ?? skillId,
          limit: numberFromRecord(budgetRecord, "limit"),
          spent: numberFromRecord(budgetRecord, "spent"),
          currency: stringFromRecord(budgetRecord, "currency"),
          disabled: budgetRecord.disabled === true,
        }
      : undefined,
  };
}

function skillRecordFromRow(row: SkillCredentialsRow): FeedHostSkillRecord {
  const value = parseStoredSkillValue(row.value_json, row.scope);
  const budget = value.budget ?? {
    budgetId: value.skillId,
    spent: 0,
    currency: "USD",
    disabled: false,
  };
  const spent = budget.spent ?? 0;
  const remaining = budget.limit === undefined ? undefined : budget.limit - spent;
  return {
    skillId: value.skillId,
    credentialMode: value.credentialMode,
    providerId: value.providerId,
    secretRef: value.secretRef,
    budget: {
      budgetId: budget.budgetId,
      limit: budget.limit,
      spent,
      currency: budget.currency ?? "USD",
      disabled: budget.disabled ?? false,
      remaining,
      status: budget.disabled || (remaining !== undefined && remaining <= 0) ? "blocked_budget" : "ready",
    },
    version: Number(row.version),
    updatedAt: row.updated_at,
  };
}

function toWireSkillState(record: FeedHostSkillRecord): FeedHostSkillState {
  return {
    skillId: record.skillId,
    credentialMode: record.credentialMode,
    providerId: record.providerId,
    hasSecret: typeof record.secretRef === "string" && record.secretRef.length > 0,
    budget: record.budget,
    version: record.version,
    updatedAt: record.updatedAt,
  };
}

function mergeSkillState(
  skillId: string,
  current: FeedHostSkillRecord | null,
  patch: FeedHostSkillCredentialsPatch,
): FeedHostSkillRecord {
  const now = new Date().toISOString();
  const nextBudget = patch.budget
    ? {
        budgetId: patch.budget.budgetId?.trim() || current?.budget.budgetId || skillId,
        limit: patch.budget.limit ?? current?.budget.limit,
        spent: patch.budget.spent ?? current?.budget.spent ?? 0,
        currency: patch.budget.currency?.trim() || current?.budget.currency || "USD",
        disabled: patch.budget.disabled ?? current?.budget.disabled ?? false,
      }
    : current?.budget
      ? {
          budgetId: current.budget.budgetId,
          limit: current.budget.limit,
          spent: current.budget.spent,
          currency: current.budget.currency,
          disabled: current.budget.disabled,
        }
      : {
          budgetId: skillId,
          spent: 0,
          currency: "USD",
          disabled: false,
        };
  const credentialMode = patch.credentialMode;
  const secretRef = resolveNextSecretRef(credentialMode, patch, current);
  if (
    (credentialMode === "user_byok_api_key" || credentialMode === "user_oauth_token") &&
    !secretRef
  ) {
    throw new FeedHostError("secretRef is required for BYOK credentials", 400, "invalid_mode");
  }
  const providerId =
    patch.providerId?.trim() ??
    current?.providerId ??
    (credentialMode === "feed_hosted" ? "openai" : undefined);
  const remaining = nextBudget.limit === undefined ? undefined : nextBudget.limit - nextBudget.spent;
  return {
    skillId,
    credentialMode,
    providerId,
    secretRef,
    budget: {
      budgetId: nextBudget.budgetId,
      limit: nextBudget.limit,
      spent: nextBudget.spent,
      currency: nextBudget.currency,
      disabled: nextBudget.disabled,
      remaining,
      status:
        nextBudget.disabled || (remaining !== undefined && remaining <= 0) ? "blocked_budget" : "ready",
    },
    version: (current?.version ?? 0) + 1,
    updatedAt: now,
  };
}

function parsePreferenceValueJson(raw: string): FeedPreferenceValue {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as FeedPreferenceValue;
  } catch {
    // Malformed preference payloads read as defaults rather than failing the list.
  }
  return {};
}

function toWireWorkflowState(
  row: WorkflowPackageStateRow,
  run: WorkflowRunIndexRow | undefined,
  example: WorkflowExampleRow | undefined,
  preferences: { value: FeedPreferenceValue; version: number } | undefined,
): FeedHostWorkflowState {
  const value = preferences?.value;
  const disclosure = parseWorkflowDisclosure(row.disclosure_json);
  const state: FeedHostWorkflowState = {
    packageId: row.package_id,
    displayName: row.display_name,
    version: row.version,
    settingsVersion: preferences?.version ?? 0,
    admissionState: row.admission_state as FeedWorkflowPackage["admissionState"],
    disclosure,
    paused: value?.paused === true || (row.paused_at !== null && row.paused_at !== undefined),
    disabled: value?.disabled === true,
    cadence: value?.cadence,
    settings: {
      sourceSelection: value?.sourceSelection,
      audience: value?.audience,
      outputVolume: value?.outputVolume,
    },
    enabledAt: row.enabled_at ?? null,
    updatedAt: row.updated_at,
  };
  if (run) {
    const startedMs = Date.parse(run.started_at);
    const finishedMs = run.finished_at ? Date.parse(run.finished_at) : Number.NaN;
    state.lastRun = {
      runId: run.run_id,
      status: run.status as FeedWorkflowRun["status"],
      startedAt: run.started_at,
      finishedAt: run.finished_at ?? null,
      durationMs:
        Number.isFinite(startedMs) && Number.isFinite(finishedMs) ? Math.max(0, finishedMs - startedMs) : null,
      publishedArtifactCount: parseJsonArrayLength(run.published_artifact_ids_json),
      error: parseRunError(run.error_json),
    };
  }
  if (example) {
    state.example = {
      artifactId: example.artifact_id,
      title: null,
      publishedAt: example.published_at,
    };
  }
  return state;
}

function parseWorkflowDisclosure(raw: string): WorkflowDisclosure {
  try {
    const parsed = JSON.parse(raw) as WorkflowDisclosure;
    if (parsed && typeof parsed === "object" && typeof parsed.userCopy === "string") return parsed;
  } catch {
    // Fall through to the redacted default below.
  }
  return { userCopy: "", credentialOwner: "none", providerClass: "none", egressClass: "none" };
}

function parseJsonArrayLength(raw: string): number {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function parseRunError(raw: string | null): { code: string; message: string } | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown };
    if (typeof parsed?.code === "string") {
      return { code: parsed.code, message: typeof parsed.message === "string" ? parsed.message.slice(0, 300) : "" };
    }
  } catch {
    // Unreadable errors stay hidden rather than leaking raw payloads.
  }
  return undefined;
}

function resolveNextSecretRef(
  credentialMode: CredentialMode,
  patch: FeedHostSkillCredentialsPatch,
  current: FeedHostSkillRecord | null,
): string | undefined {
  // "none" clears any prior secret so remove() genuinely wipes the reference.
  if (credentialMode === "none") return undefined;
  // For feed_hosted, the server picks a fixed vault ref by provider; never
  // trust the client's submitted secretRef here.
  if (credentialMode === "feed_hosted") {
    return providerSecretRefFor(patch.providerId?.trim() ?? current?.providerId ?? "openai");
  }
  const submitted = patch.secretRef?.trim();
  if (submitted) return submitted;
  return current?.secretRef;
}

function providerSecretRefFor(providerId: string): string {
  switch (providerId) {
    case "phala":
      return "vault/secrets/scoped/feed/REDPILL_API_KEY";
    default:
      return "vault/secrets/scoped/feed/OPENAI_API_KEY";
  }
}

function responseRows<T extends Record<string, unknown>>(response: QueryResponse<T>): T[] {
  return response.rows.map((row) => {
    if (!Array.isArray(row)) return row as T;
    return Object.fromEntries(response.columns.map((column, index) => [column, row[index]])) as T;
  });
}

function insertSql(row: SqlSeedRow): string {
  const keys = Object.keys(row.values);
  const columns = keys.map(identifier).join(", ");
  const placeholders = keys.map(() => "?").join(", ");
  return `INSERT OR REPLACE INTO ${identifier(row.table)} (${columns}) VALUES (${placeholders})`;
}

function identifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) throw new Error(`unsafe SQL identifier: ${value}`);
  return value;
}

function sqlValue(value: string | number | null): SqlValue {
  return value;
}

function artifactDocKey(docKey: string): string {
  const trimmed = docKey.replace(/^\/+/, "");
  if (trimmed === "" || trimmed.includes("..")) throw new Error(`unsafe artifact doc key: ${docKey}`);
  return trimmed.startsWith(`${FEED_HOST_ARTIFACT_DOC_PREFIX}/`)
    ? trimmed
    : `${FEED_HOST_ARTIFACT_DOC_PREFIX}/${trimmed}`;
}

function artifactHeroReference(body: unknown): { key: string; contentType?: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const hero = record.hero_image;
  const bodyMime = imageMime(record.hero_image_mime);
  if (typeof hero === "string" && hero.trim()) return { key: hero.trim(), ...(bodyMime ? { contentType: bodyMime } : {}) };
  if (!hero || typeof hero !== "object" || Array.isArray(hero)) return null;
  const heroRecord = hero as Record<string, unknown>;
  const key = ["key", "path", "mediaKey", "storageKey", "src"]
    .map((field) => heroRecord[field])
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!key) return null;
  const contentType = bodyMime ?? ["mime", "mimeType", "contentType"]
    .map((field) => imageMime(heroRecord[field]))
    .find((value): value is string => Boolean(value));
  return { key: key.trim(), ...(contentType ? { contentType } : {}) };
}

// A hero reference may be a full media key, a media-relative path, or just a
// filename from a migrated distillery doc. Expand to concrete candidates;
// bare filenames resolve inside the artifact's media directory, preferring
// the .b64 variant the legacy pipeline wrote.
function heroKeyCandidates(reference: string, artifactId: string): string[] {
  const trimmed = reference.trim();
  if (trimmed.includes("/")) return [trimmed];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed) || !/^[A-Za-z0-9._:-]+$/.test(artifactId)) return [];
  const dir = `xyz.tinycloud.artifacts/media/${artifactId}`;
  return trimmed.endsWith(".b64")
    ? [`${dir}/${trimmed}`]
    : [`${dir}/${trimmed}.b64`, `${dir}/${trimmed}`];
}

function artifactMediaKey(value: string): string | null {
  const trimmed = value.replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("..") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  const mediaPrefix = "xyz.tinycloud.artifacts/media/";
  const key = trimmed.startsWith(mediaPrefix)
    ? trimmed
    : trimmed.startsWith("media/")
      ? `xyz.tinycloud.artifacts/${trimmed}`
      : "";
  return key.startsWith(mediaPrefix) ? key : null;
}

// Raster whitelist only — image/svg+xml is script-capable markup and serving
// it from the authenticated host origin would be an XSS vector.
const SAFE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

function imageMime(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return SAFE_IMAGE_MIMES.has(normalized) ? normalized : undefined;
}

function decodeBase64Media(value: string): { bytes: Uint8Array; contentType?: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const dataUri = trimmed.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is);
  const encoded = (dataUri?.[2] ?? trimmed).replaceAll(/\s+/g, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) return null;
  const declaredMime = dataUri ? imageMime(dataUri[1]) : undefined;
  return { bytes: new Uint8Array(bytes), ...(declaredMime ? { contentType: declaredMime } : {}) };
}

function imageContentType(key: string): string {
  const fileName = key.toLowerCase().replace(/\.b64$/, "");
  if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) return "image/jpeg";
  if (fileName.endsWith(".webp")) return "image/webp";
  if (fileName.endsWith(".gif")) return "image/gif";
  if (fileName.endsWith(".avif")) return "image/avif";
  // SVG is deliberately absent: script-capable markup served from the
  // authenticated host origin is an XSS vector. Raster formats only.
  return "image/png";
}

function hydrateArtifactDocument(
  value: unknown,
): { kind: "found"; artifact: FeedArtifact } | { kind: "malformed"; error: string } | { kind: "schema_mismatch"; errors: string[] } {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return { kind: "parsed" as const, value: JSON.parse(value) };
          } catch (error) {
            return {
              kind: "malformed" as const,
              error: error instanceof Error ? error.message : "artifact document is not valid JSON",
            };
          }
        })()
      : { kind: "parsed" as const, value };
  if (parsed.kind === "malformed") return parsed;
  const validated = validateFeedArtifact(parsed.value);
  if (!validated.ok) return { kind: "schema_mismatch", errors: validated.errors };
  return { kind: "found", artifact: validated.value };
}

function defaultPreferenceValue(): FeedPreferenceValue {
  return defaultFeedPreferences();
}

function mergePreferencePatch(base: FeedPreferenceValue, patch: FeedPreferenceValue): FeedPreferenceValue {
  const sanitizedBase = sanitizePreferenceValue(base);
  const next: FeedPreferenceValue = {
    ...sanitizedBase,
    packagePriority: { ...(sanitizedBase.packagePriority ?? {}) },
    typePriority: { ...(sanitizedBase.typePriority ?? {}) },
    sourcePriority: { ...(sanitizedBase.sourcePriority ?? {}) },
    savedArtifactIds: [...(sanitizedBase.savedArtifactIds ?? [])],
    hiddenArtifactIds: [...(sanitizedBase.hiddenArtifactIds ?? [])],
    packageDisabled: [...(sanitizedBase.packageDisabled ?? [])],
    typeSuppressed: [...(sanitizedBase.typeSuppressed ?? [])],
    showFewerPackageIds: { ...(sanitizedBase.showFewerPackageIds ?? {}) },
  };
  if (patch.packagePriority) next.packagePriority = { ...(next.packagePriority ?? {}), ...stringNumberMap(patch.packagePriority) };
  if (patch.typePriority) next.typePriority = { ...(next.typePriority ?? {}), ...stringNumberMap(patch.typePriority) };
  if (patch.sourcePriority) next.sourcePriority = { ...(next.sourcePriority ?? {}), ...stringNumberMap(patch.sourcePriority) };
  if (patch.savedArtifactIds) next.savedArtifactIds = uniqueStrings([...(next.savedArtifactIds ?? []), ...patch.savedArtifactIds]);
  if (patch.hiddenArtifactIds) next.hiddenArtifactIds = uniqueStrings([...(next.hiddenArtifactIds ?? []), ...patch.hiddenArtifactIds]);
  if (patch.packageDisabled) next.packageDisabled = uniqueStrings([...(next.packageDisabled ?? []), ...patch.packageDisabled]);
  if (patch.typeSuppressed) next.typeSuppressed = uniqueStrings([...(next.typeSuppressed ?? []), ...patch.typeSuppressed]);
  if (patch.showFewerPackageIds) next.showFewerPackageIds = { ...(next.showFewerPackageIds ?? {}), ...stringNumberMap(patch.showFewerPackageIds) };
  if (Number.isFinite(patch.cooldownMinutes ?? NaN)) next.cooldownMinutes = Number(patch.cooldownMinutes);
  if (Number.isFinite(patch.diversityWindow ?? NaN)) next.diversityWindow = Number(patch.diversityWindow);
  if (Number.isFinite(patch.priority ?? NaN)) next.priority = Number(patch.priority);
  if (typeof patch.paused === "boolean") next.paused = patch.paused;
  if (typeof patch.disabled === "boolean") next.disabled = patch.disabled;
  if (patch.cadence === "more" || patch.cadence === "normal" || patch.cadence === "less") next.cadence = patch.cadence;
  return next;
}

function preferenceRecordFromRow(row: PreferenceRow): FeedPreferenceProfileRecord {
  return {
    profileId: row.profile_id,
    actorId: row.actor_id,
    scope: row.scope,
    value: JSON.parse(row.value_json) as FeedPreferenceValue,
    version: Number(row.version),
    updatedAt: row.updated_at,
  };
}

function preferenceProfileId(actorId: string, scope: string): string {
  return `${normalizeActorId(actorId)}:${scope}`;
}

function preferenceKey(actorId: string, scope: string): string {
  return `${FEED_HOST_FEED_SETTINGS_PREFIX}/${encodeURIComponent(normalizeActorId(actorId))}/${encodeURIComponent(scope)}.json`;
}

function plainObjectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeControlIntentKind(kind: FeedControlIntentInput["intentKind"]): FeedControlIntentInput["intentKind"] {
  return kind === "ask_feed" ? "generate_new_request" : kind;
}

function preferenceScopeForIntent(
  kind: FeedControlIntentInput["intentKind"],
  payload: Record<string, unknown> | undefined,
  targetRef: string,
): string {
  const expectedScope =
    kind === "safe_package_setting_update" ||
    kind === "candidate_package_proposal" ||
    kind === "enable_package" ||
    kind === "pause_package" ||
    kind === "disable_package" ||
    kind === "tune_package" ||
    kind === "reset_package"
      ? `package:${packageIdFromTarget(targetRef) ?? targetRef}`
      : FEED_HOST_PREFERENCES_SCOPE;

  if (typeof payload?.scope === "string" && payload.scope.trim() !== "" && payload.scope !== expectedScope) {
    throw new FeedHostError("preference scope is not allowlisted", 400, "invalid_intent");
  }

  return expectedScope;
}

function controlIntentPreferencePatch(
  kind: FeedControlIntentInput["intentKind"],
  payload: Record<string, unknown> | undefined,
  targetRef: string,
): FeedPreferenceValue {
  const patch = plainObjectOrUndefined(payload?.value) ?? plainObjectOrUndefined(payload?.settings) ?? payload ?? {};
  switch (kind) {
    case "set_cadence": {
      const cadence =
        typeof payload?.cadence === "string" ? payload.cadence : typeof patch.cadence === "string" ? patch.cadence : undefined;
      const packageId = packageIdFromTarget(targetRef);
      const showFewerPackageIds = packageId ? { [packageId]: cadence === "less" ? 1 : cadence === "more" ? 0 : 0 } : undefined;
      return {
        cadence: cadence === "more" || cadence === "normal" || cadence === "less" ? cadence : undefined,
        showFewerPackageIds,
      };
    }
    case "enable_package":
      return { paused: false, disabled: false };
    case "pause_package":
      return { paused: true };
    case "disable_package":
      return { disabled: true };
    case "reset_package":
      return {};
    case "candidate_package_proposal":
      return sanitizePreferencePatch({ ...patch, disabled: true });
    case "safe_package_setting_update":
    case "tune_package":
    case "adjust_preference":
    default:
      return sanitizePreferencePatch(patch);
  }
}

function generationScopeFromPayload(
  payload: Record<string, unknown> | undefined,
  targetRef: string,
): { artifactType?: string; packageId?: string; sourceRefId?: string; targetRef?: string } {
  const scope = plainObjectOrUndefined(payload?.scope);
  if (scope) {
    return {
      artifactType: typeof scope.artifactType === "string" ? scope.artifactType : undefined,
      packageId: typeof scope.packageId === "string" ? scope.packageId : undefined,
      sourceRefId: typeof scope.sourceRefId === "string" ? scope.sourceRefId : undefined,
      targetRef: typeof scope.targetRef === "string" ? scope.targetRef : targetRef,
    };
  }
  return {
    artifactType: typeof payload?.artifactType === "string" ? payload.artifactType : undefined,
    packageId: typeof payload?.packageId === "string" ? payload.packageId : undefined,
    sourceRefId: typeof payload?.sourceRefId === "string" ? payload.sourceRefId : undefined,
    targetRef,
  };
}

function sanitizePreferencePatch(patch: Record<string, unknown>): FeedPreferenceValue {
  const result: FeedPreferenceValue = {};
  if (patch.packagePriority && typeof patch.packagePriority === "object" && !Array.isArray(patch.packagePriority)) {
    result.packagePriority = stringNumberMap(patch.packagePriority as Record<string, number>);
  }
  if (patch.typePriority && typeof patch.typePriority === "object" && !Array.isArray(patch.typePriority)) {
    result.typePriority = stringNumberMap(patch.typePriority as Record<string, number>);
  }
  if (patch.sourcePriority && typeof patch.sourcePriority === "object" && !Array.isArray(patch.sourcePriority)) {
    result.sourcePriority = stringNumberMap(patch.sourcePriority as Record<string, number>);
  }
  if (Array.isArray(patch.savedArtifactIds)) result.savedArtifactIds = uniqueStrings(patch.savedArtifactIds.filter((value): value is string => typeof value === "string"));
  if (Array.isArray(patch.hiddenArtifactIds)) result.hiddenArtifactIds = uniqueStrings(patch.hiddenArtifactIds.filter((value): value is string => typeof value === "string"));
  if (Array.isArray(patch.packageDisabled)) result.packageDisabled = uniqueStrings(patch.packageDisabled.filter((value): value is string => typeof value === "string"));
  if (Array.isArray(patch.typeSuppressed)) result.typeSuppressed = uniqueStrings(patch.typeSuppressed.filter((value): value is string => typeof value === "string"));
  if (patch.showFewerPackageIds && typeof patch.showFewerPackageIds === "object" && !Array.isArray(patch.showFewerPackageIds)) {
    result.showFewerPackageIds = stringNumberMap(patch.showFewerPackageIds as Record<string, number>);
  }
  if (typeof patch.cooldownMinutes === "number") result.cooldownMinutes = patch.cooldownMinutes;
  if (typeof patch.diversityWindow === "number") result.diversityWindow = patch.diversityWindow;
  if (typeof patch.priority === "number") result.priority = patch.priority;
  if (typeof patch.paused === "boolean") result.paused = patch.paused;
  if (typeof patch.disabled === "boolean") result.disabled = patch.disabled;
  if (patch.cadence === "more" || patch.cadence === "normal" || patch.cadence === "less") result.cadence = patch.cadence;
  return result;
}

function packageIdFromTarget(targetRef: string): string | undefined {
  const normalized = targetRef.startsWith("package:") ? targetRef.slice("package:".length) : targetRef;
  if (normalized.trim() === "" || normalized.includes("/") || normalized.includes("\\")) return undefined;
  return normalized;
}

function normalizePreferenceScope(scope?: string): string {
  const value = scope ?? FEED_HOST_PREFERENCES_SCOPE;
  if (value === FEED_HOST_PREFERENCES_SCOPE) return value;
  if (/^package:[^/\\]+$/.test(value)) return value;
  throw new FeedHostError("preference scope is not allowlisted", 400, "invalid_preferences");
}

function projectionStateFromRow(row: ProjectionRow): FeedProjectionState {
  const reasonCodes = JSON.parse(row.reason_codes_json) as string[];
  return {
    feedItemId: row.feed_item_id,
    target: row.target_kind === "post" && row.post_id
      ? { kind: "post", artifactId: row.artifact_id, postId: row.post_id }
      : { kind: "artifact_preview", artifactId: row.artifact_id },
    artifactType: row.artifact_type,
    packageId: row.package_id,
    sourceFingerprint: row.source_fingerprint,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    freshnessLabel: row.freshness_label,
    disposition: row.disposition,
    visibility: row.visibility,
    reasonCodes,
    rankScore: Number(row.rank_score),
    docMissing: row.visibility === "repair_only" || reasonCodes.includes("broken_ref"),
  };
}

function stripProjectionState(row: FeedProjectionState, artifact?: FeedArtifact | null): FeedItemProjection {
  const postId = row.target.kind === "post" ? row.target.postId : undefined;
  const post = artifact && postId ? postsFromArtifact(artifact).find((candidate) => candidate.postId === postId) : undefined;
  const projection: FeedItemProjection = {
    feedItemId: row.feedItemId,
    target: row.target,
    ...(post?.title ? { postTitle: post.title } : {}),
    ...(post?.body ? { postBody: post.body } : {}),
    ...(post?.expansionTarget.sectionId ? { sectionRef: post.expansionTarget.sectionId } : {}),
    rankScore: row.rankScore,
    disposition: row.disposition,
    visibility: row.visibility,
    freshnessLabel: row.freshnessLabel,
    reasonCodes: [...row.reasonCodes],
    packageId: row.packageId,
    sourceFingerprint: row.sourceFingerprint,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
  if (artifact) {
    const joined = validateFeedItemProjectionJoin(projection, artifact);
    if (!joined.ok) throw new FeedHostError("feed item projection join is invalid", 500, "invalid_projection_join", { errors: joined.errors });
  }
  return projection;
}

function projectionSqlRow(row: FeedProjectionState): SqlStatement {
  const validated = validateFeedItemProjection(stripProjectionState(row));
  if (!validated.ok) throw new FeedHostError("feed item projection is invalid", 500, "invalid_projection", { errors: validated.errors });
  return {
    sql: `INSERT OR REPLACE INTO feed_item_projection (
      feed_item_id, target_kind, artifact_id, post_id,
      rank_score, disposition, visibility, freshness_label, reason_codes_json,
      package_id, source_fingerprint, published_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.feedItemId,
      row.target.kind,
      row.target.artifactId,
      row.target.kind === "post" ? row.target.postId : null,
      row.rankScore,
      row.disposition,
      row.visibility,
      row.freshnessLabel,
      JSON.stringify(row.reasonCodes),
      row.packageId,
      row.sourceFingerprint,
      row.publishedAt,
      row.updatedAt,
    ],
  };
}

function legacyProjectionSqlRow(row: FeedProjectionState): SqlStatement {
  return {
    sql: `INSERT OR REPLACE INTO feed_artifact_projection (
      artifact_id, rank_score, disposition, visibility, freshness_label,
      reason_codes_json, package_id, source_fingerprint, published_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.target.artifactId,
      row.rankScore,
      row.disposition,
      row.visibility,
      row.freshnessLabel,
      JSON.stringify(row.reasonCodes),
      row.packageId,
      row.sourceFingerprint,
      row.publishedAt,
      row.updatedAt,
    ],
  };
}

function stringNumberMap(value: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => Number.isFinite(entry))
      .map(([key, entry]) => [key, Number(entry)] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== "").map((value) => value.trim()))];
}

function count(db: IDatabaseHandle, table: string): Promise<number> {
  return queryRows<{ count: number }>(db, `SELECT COUNT(*) AS count FROM ${identifier(table)}`).then(
    (rows) => Number(rows[0]?.count ?? 0),
  );
}

function promptFromPayload(payload: Record<string, unknown> | undefined): string | null {
  if (payload && typeof payload.prompt === "string") return payload.prompt;
  return null;
}

function dispositionForSignal(signal: FeedbackEvent["signal"]): FeedArtifactProjection["disposition"] | null {
  switch (signal) {
    case "save":
      return "saved";
    case "hide":
      return "hidden";
    case "unsave":
    case "unhide":
      return "default";
    default:
      return null;
  }
}

function interactionTargetFromRow(row: FeedbackDbRow): FeedInteractionTarget {
  if (row.targetKind === "feed_item" && row.feedItemId) return { kind: "feed_item", feedItemId: row.feedItemId };
  if (row.targetKind === "post" && row.artifactId && row.postId) {
    return { kind: "post", artifactId: row.artifactId, postId: row.postId };
  }
  if (row.artifactId) return { kind: "artifact", artifactId: row.artifactId };
  throw new FeedHostError("stored interaction target is invalid", 500, "invalid_interaction_target");
}

function projectionDispositionSql(target: FeedInteractionTarget): string {
  switch (target.kind) {
    case "artifact":
      return `UPDATE feed_item_projection SET disposition = ?, updated_at = ? WHERE artifact_id = ?`;
    case "post":
      return `UPDATE feed_item_projection SET disposition = ?, updated_at = ? WHERE target_kind = 'post' AND artifact_id = ? AND post_id = ?`;
    case "feed_item":
      return `UPDATE feed_item_projection SET disposition = ?, updated_at = ? WHERE feed_item_id = ?`;
  }
}

function projectionDispositionParams(
  target: FeedInteractionTarget,
  disposition: FeedArtifactProjection["disposition"],
  updatedAt: string,
): SqlValue[] {
  switch (target.kind) {
    case "artifact": return [disposition, updatedAt, target.artifactId];
    case "post": return [disposition, updatedAt, target.artifactId, target.postId];
    case "feed_item": return [disposition, updatedAt, target.feedItemId];
  }
}

const GENERATION_REQUEST_INSERT_COLUMNS = [
  "request_id", "reader_nonce", "actor_id", "status", "scope_json", "package_id", "dedupe_key",
  "prompt", "run_id", "workflow_id", "max_attempts", "claim_owner", "lease_expires_at", "fencing_token", "attempt_count",
  "next_retry_at", "cancellation_requested", "phase", "phase_started_at", "started_at",
  "completed_at", "last_attempt_at", "source_cursor_before", "source_cursor_after", "source_refs_json",
  "publication_key", "artifact_ids_json", "publication_manifest_json", "error_json", "timing_events_json",
  "expires_at", "created_at", "updated_at",
] as const;

export function generationRequestSql(request: FeedGenerationRequestRecord): SqlStatement {
  const params = [
    request.requestId,
    request.readerNonce,
    request.actorId,
    request.status,
    JSON.stringify(request.scope),
    request.packageId,
    request.dedupeKey,
    request.prompt,
    request.runId,
    request.workflowId,
    request.maxAttempts,
    request.claimOwner,
    request.leaseExpiresAt,
    request.fencingToken,
    request.attemptCount,
    request.nextRetryAt,
    request.cancellationRequested ? 1 : 0,
    request.phase,
    request.phaseStartedAt,
    request.startedAt,
    request.completedAt,
    request.lastAttemptAt,
    serializeJson(request.sourceCursorBefore),
    serializeJson(request.sourceCursorAfter),
    JSON.stringify(request.sourceRefs),
    request.publicationKey,
    JSON.stringify(request.artifactIds),
    request.publicationManifest === null ? null : stableJson(request.publicationManifest),
    request.error === null ? null : JSON.stringify(request.error),
    JSON.stringify(request.timingEvents),
    request.expiresAt,
    request.createdAt,
    request.updatedAt,
  ];
  // Placeholders derive from the column list so the two can never drift (a
  // hardcoded count previously produced 35 placeholders for 33 columns).
  if (params.length !== GENERATION_REQUEST_INSERT_COLUMNS.length) {
    throw new Error(`generation_request column/param mismatch: ${GENERATION_REQUEST_INSERT_COLUMNS.length} columns, ${params.length} params`);
  }
  return {
    sql: `INSERT OR REPLACE INTO generation_request (${GENERATION_REQUEST_INSERT_COLUMNS.join(", ")}) VALUES (${GENERATION_REQUEST_INSERT_COLUMNS.map(() => "?").join(", ")})`,
    params,
  };
}

function generationRequestFromRow(row: GenerationRequestRow): FeedGenerationRequestRecord {
  return {
    requestId: row.request_id,
    readerNonce: row.reader_nonce,
    actorId: row.actor_id,
    status: row.status,
    scope: JSON.parse(row.scope_json) as FeedGenerationRequestRecord["scope"],
    packageId: row.package_id,
    dedupeKey: row.dedupe_key,
    prompt: row.prompt,
    runId: row.run_id ?? null,
    workflowId: row.workflow_id ?? null,
    maxAttempts: Number(row.max_attempts ?? 3),
    claimOwner: row.claim_owner ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    fencingToken: Number(row.fencing_token ?? 0),
    attemptCount: Number(row.attempt_count ?? 0),
    nextRetryAt: row.next_retry_at ?? null,
    cancellationRequested: Number(row.cancellation_requested ?? 0) === 1,
    phase: row.phase ?? "queued",
    phaseStartedAt: row.phase_started_at ?? null,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
    sourceCursorBefore: parseJson(row.source_cursor_before, null),
    sourceCursorAfter: parseJson(row.source_cursor_after, null),
    sourceRefs: parseJson(row.source_refs_json, []),
    publicationKey: row.publication_key ?? null,
    artifactIds: parseJson(row.artifact_ids_json, []),
    publicationManifest: parseJson(row.publication_manifest_json, null),
    error: parseJson(row.error_json, null),
    timingEvents: parseJson(row.timing_events_json, []),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function generationMetadataSql(metadata: FeedGenerationMetadataPatch): { setClause: string; params: SqlValue[] } {
  const assignments: string[] = [];
  const params: SqlValue[] = [];
  if (Object.hasOwn(metadata, "sourceCursorAfter")) {
    assignments.push("source_cursor_after = ?");
    params.push(serializeJson(metadata.sourceCursorAfter));
  }
  if (metadata.sourceRefs !== undefined) {
    assignments.push("source_refs_json = ?");
    params.push(JSON.stringify(metadata.sourceRefs));
  }
  if (metadata.timingEvents !== undefined) {
    assignments.push("timing_events_json = ?");
    params.push(JSON.stringify(metadata.timingEvents));
  }
  return {
    setClause: assignments.length > 0 ? `${assignments.join(", ")},` : "",
    params,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return [...left].sort().join("\u0000") === [...right].sort().join("\u0000");
}

function assertArtifactSourcesWereCheckpointed(artifact: FeedArtifact, checkpointed: unknown[]): void {
  const allowed = new Set(checkpointed.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const ref = value as Record<string, unknown>;
    return typeof ref.sourceRefId === "string" && typeof ref.observedHash === "string"
      ? [`${ref.sourceRefId}\u0000${ref.observedHash}`]
      : [];
  }));
  if (artifact.sourceRefs.some((ref) => !allowed.has(`${ref.sourceRefId}\u0000${ref.observedHash}`))) {
    throw new FeedHostError("artifact source refs were not checkpointed by this run", 400, "invalid_artifact");
  }
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function publicationConflict(): FeedHostError {
  return new FeedHostError("publication does not match the immutable request manifest", 409, "publication_conflict");
}

function generationLeaseConflict(): FeedHostError {
  return new FeedHostError("generation request lease is stale", 409, "stale_generation_lease");
}

function resultError(result: unknown): string {
  const error = (result as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  if (error?.message) return String(error.message);
  if (error?.code) return String(error.code);
  if (result instanceof Error) return result.message;
  return String(result);
}

function multiResourceInvocationUnsupported(message: string): boolean {
  return message.includes("does not support multi-resource invocations");
}

function isDuplicateColumn(error: unknown): boolean {
  const message = (error as { message?: unknown } | null)?.message;
  return /duplicate column name/i.test(message ? String(message) : resultError(error));
}

async function readLegacyRows(
  access: DelegatedAccess | undefined,
  dbPath: string,
  table: string,
): Promise<Record<string, unknown>[]> {
  if (!access) return [];
  try {
    const orderBy = table === "artifact" ? "published_at ASC, id ASC" : "recorded_at ASC, id ASC";
    return await queryRows<Record<string, unknown>>(
      access.sql.db(dbPath),
      `SELECT * FROM ${identifier(table)} ORDER BY ${orderBy}`,
    );
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table/i.test(message);
}

function emptyMigrationSummary(): FeedV1MigrationSummary {
  return {
    legacyArtifacts: 0,
    legacyInteractions: 0,
    migratedArtifacts: 0,
    migratedArtifactDocs: 0,
    migratedArtifactRows: 0,
    migratedFeedRows: 0,
    migratedFeedbackEvents: 0,
    migratedControlIntents: 0,
    migratedGenerationRequests: 0,
    skippedArtifacts: 0,
    skippedInteractions: 0,
  };
}
