import type {
  DelegatedAccess,
  IDatabaseHandle,
  QueryResponse,
  SqlStatement,
  SqlValue,
} from "@tinycloud/node-sdk";
import { type FeedArtifact, type FeedArtifactProjection, type FeedbackEvent, validateFeedArtifact } from "../../artifactory/skills/_shared/lib/feed-v1.ts";
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
  FEED_HOST_PREFERENCES_SCOPE,
} from "./logic.ts";

type ProjectionRow = {
  artifact_id: string;
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
  eventId: string;
  artifactId: string;
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

type GenerationRequestRow = {
  request_id: string;
  reader_nonce: string;
  actor_id: string;
  status: FeedGenerationRequestRecord["status"];
  scope_json: string;
  package_id: string | null;
  dedupe_key: string | null;
  prompt: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type FeedHostActorStorage = {
  actorId: string;
  artifacts: DelegatedAccess;
  feed: DelegatedAccess;
  settings: DelegatedAccess;
  documents: DelegatedAccess;
  legacyArtifacts?: DelegatedAccess;
  legacyInteractions?: DelegatedAccess;
};

export type FeedHostStorageOptions = {
  migrateLegacyData?: (actor: FeedHostActorStorage) => Promise<FeedV1MigrationSummary>;
};

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

export class FeedHostStorage {
  private readonly bootstrapped = new WeakSet<object>();
  private readonly migrateLegacyDataHook: (actor: FeedHostActorStorage) => Promise<FeedV1MigrationSummary>;

  constructor(options: FeedHostStorageOptions = {}) {
    this.migrateLegacyDataHook = options.migrateLegacyData ?? ((actor) => this.performLegacyMigration(actor));
  }

  async bootstrapSchema(actor: FeedHostActorStorage): Promise<FeedV1MigrationSummary> {
    if (this.bootstrapped.has(actor)) return emptyMigrationSummary();
    assertFeedV1SchemaUsesMigrations();
    for (const plan of feedV1MigrationApplyPlans()) {
      const db = this.db(actor, plan.dbName);
      const migrated = await applyMigrations(db, {
        namespace: plan.namespace,
        migrations: plan.migrations,
      });
      if (!migrated.ok) throw new Error(`Failed to initialize ${plan.dbName}: ${resultError(migrated)}`);
    }
    const migrationSummary = await this.migrateLegacyDataHook(actor);
    this.bootstrapped.add(actor);
    return migrationSummary;
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

  async writeArtifactDocument(actor: FeedHostActorStorage, artifact: FeedArtifact | MigratedFeedArtifact): Promise<void> {
    const result = await actor.documents.kv.put(artifactDocKey(artifact.storage.docKey), artifact, {
      contentType: "application/json",
    });
    if (!result.ok) throw new Error(`Failed to write artifact document: ${resultError(result)}`);
  }

  async listFeed(
    actor: FeedHostActorStorage,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: FeedArtifactProjection[]; nextCursor?: string }> {
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error("cursor must be a non-negative integer offset");
    const limit = Math.max(1, Math.min(input.limit, 100));
    const [projectionRows, feedbackRows, preferenceRows] = await Promise.all([
      this.readProjectionStates(actor),
      this.readFeedbackRows(actor),
      this.listPreferenceProfiles(actor),
    ]);
    const ranked = rankFeedProjections({
      items: projectionRows,
      feedbackByArtifact: summarizeFeedbackEvents(feedbackRows),
      preferences: mergeFeedPreferences(preferenceRows),
    });
    const page = ranked.slice(offset, offset + limit);
    return {
      items: page.map(stripProjectionState),
      nextCursor: ranked.length > offset + limit ? String(offset + limit) : undefined,
    };
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
    return this.readPreferenceProfileByActor(actor, actor.actorId, scope);
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
    const scope = input.scope ?? FEED_HOST_PREFERENCES_SCOPE;
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
    const [currentRows, artifactRows] = await Promise.all([this.readProjectionStates(actor), this.readArtifactIndexRows(actor)]);
    const artifacts: FeedReconcileArtifact[] = [];
    for (const artifactRow of artifactRows) {
      const current = currentRows.find((row) => row.artifactId === artifactRow.artifact_id);
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
      });
    }
    const plan = reconcileFeedProjections({ artifacts, projections: currentRows });
    if (plan.upserts.length === 0 && plan.deletions.length === 0) return plan;

    const statements: SqlStatement[] = plan.upserts.map(projectionSqlRow);
    if (plan.deletions.length > 0) {
      statements.push({
        sql: `DELETE FROM feed_artifact_projection WHERE artifact_id IN (${plan.deletions.map(() => "?").join(", ")})`,
        params: plan.deletions,
      });
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
    return plan;
  }

  async recordFeedback(
    actor: FeedHostActorStorage,
    event: FeedbackEvent,
  ): Promise<{ eventId: string; duplicate: boolean; status: "applied" | "noop" }> {
    const normalizedActorId = normalizeActorId(event.actorId);
    const existing = await this.findFeedbackEvent(actor, normalizedActorId, event.readerNonce);
    if (existing) return { eventId: existing.eventId, duplicate: true, status: "noop" };

    const payloadHash = event.payloadHash ?? hashJson(event.payload ?? null);
    const statements: SqlStatement[] = [
      {
        sql: `INSERT INTO feedback_event (
          event_id, artifact_id, reader_nonce, actor_id, signal, payload_json, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          event.eventId,
          event.artifactId,
          event.readerNonce,
          normalizedActorId,
          event.signal,
          event.payload === undefined ? null : JSON.stringify(event.payload),
          payloadHash,
          event.createdAt,
        ],
      },
    ];
    const disposition = dispositionForSignal(event.signal);
    if (disposition) {
      statements.push({
        sql: `UPDATE feed_artifact_projection SET disposition = ?, updated_at = ? WHERE artifact_id = ?`,
        params: [disposition, event.createdAt, event.artifactId],
      });
    }
    await batch(this.db(actor, "feed_index"), statements);

    if (event.signal === "show_fewer") {
      const projection = await this.readProjectionByArtifactId(actor, event.artifactId);
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

  async listGenerationRequests(actor: FeedHostActorStorage, limit = 100): Promise<GenerationRequestRow[]> {
    const rows = await queryRows<GenerationRequestRow>(
      this.db(actor, "feed_index"),
      `SELECT request_id, reader_nonce, actor_id, status, scope_json, package_id, dedupe_key, prompt, expires_at, created_at, updated_at
         FROM generation_request
        WHERE actor_id = ?
        ORDER BY created_at DESC
        LIMIT ?`,
      [normalizeActorId(actor.actorId), Math.max(1, Math.min(limit, 500))],
    );
    return rows;
  }

  async listFeedEvents(actor: FeedHostActorStorage, afterEventId?: string): Promise<string> {
    const projections = await this.readProjectionStates(actor);
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
      count(this.db(actor, "feed_index"), "feed_artifact_projection"),
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

  private async readProjectionStates(actor: FeedHostActorStorage): Promise<FeedProjectionState[]> {
    const rows = await queryRows<ProjectionRow>(
      this.db(actor, "feed_index"),
      `SELECT p.artifact_id, p.rank_score, p.disposition, p.visibility, p.freshness_label, p.reason_codes_json,
              p.package_id, p.source_fingerprint, p.published_at, p.updated_at, a.artifact_type
         FROM feed_artifact_projection AS p
         JOIN artifact_index AS a ON a.artifact_id = p.artifact_id
        ORDER BY p.published_at DESC, p.artifact_id ASC`,
    );
    return rows.map(projectionStateFromRow);
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
    return queryRows<FeedbackRow>(
      this.db(actor, "feed_index"),
      `SELECT event_id AS eventId, artifact_id AS artifactId, signal, created_at AS createdAt
         FROM feedback_event
        WHERE actor_id = ?
        ORDER BY created_at ASC`,
      [normalizeActorId(actor.actorId)],
    );
  }

  private async readWorkflowRuns(
    actor: FeedHostActorStorage,
  ): Promise<Array<{ runId: string; packageId: string; status: string; startedAt: string; finishedAt?: string | null }>> {
    const rows = await queryRows<{ run_id: string; package_id: string; status: string; started_at: string; finished_at: string | null }>(
      this.db(actor, "artifacts_index"),
      `SELECT run_id, package_id, status, started_at, finished_at
         FROM workflow_run_index
        ORDER BY started_at DESC`,
    );
    return rows.map((row) => ({
      runId: row.run_id,
      packageId: row.package_id,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
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
    return hydrateArtifactDocument(result.data.data);
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

  private async findFeedbackEvent(actor: FeedHostActorStorage, actorId: string, readerNonce: string): Promise<FeedbackRow | null> {
    const rows = await queryRows<FeedbackRow>(
      this.db(actor, "feed_index"),
      `SELECT event_id AS eventId, artifact_id AS artifactId, signal, created_at AS createdAt
         FROM feedback_event
        WHERE actor_id = ? AND reader_nonce = ?`,
      [actorId, readerNonce],
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
            await this.writePreferenceProfileRecord(actor, {
              profileId: preferenceProfileId(event.actorId, scope),
              actorId: event.actorId,
              scope,
              value: scope === FEED_HOST_PREFERENCES_SCOPE ? defaultPreferenceValue() : {},
              version: (current?.version ?? 0) + 1,
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
        sql: `UPDATE feed_artifact_projection SET disposition = ?, updated_at = ? WHERE artifact_id = ?`,
        params: [disposition, updatedAt, artifactId],
      },
    ]);
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
      `SELECT request_id, reader_nonce, actor_id, status, scope_json, package_id, dedupe_key, prompt, expires_at, created_at, updated_at
         FROM generation_request
        WHERE actor_id = ? AND (reader_nonce = ? OR dedupe_key = ?)
        LIMIT 1`,
      [input.actorId, input.readerNonce, dedupeKey],
    );
    const row = existing[0];
    if (row) return generationRequestFromRow(row);
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
    if (!multiResourceInvocationUnsupported(resultError(result))) {
      return { ok: false, error: result.error };
    }
  }

  for (const migration of input.migrations) {
    const batched = await db.batch(migration.sql.map((sql) => ({ sql }))).catch((error) => ({ ok: false as const, error }));
    if (batched.ok) continue;
    if (!multiResourceInvocationUnsupported(resultError(batched))) return { ok: false, error: batched.error };
    for (const sql of migration.sql) {
      const result = await db.execute(sql).catch((error) => ({ ok: false as const, error }));
      if (!result.ok) return { ok: false, error: result.error };
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
  const next: FeedPreferenceValue = {
    ...base,
    packagePriority: { ...(base.packagePriority ?? {}) },
    typePriority: { ...(base.typePriority ?? {}) },
    sourcePriority: { ...(base.sourcePriority ?? {}) },
    savedArtifactIds: [...(base.savedArtifactIds ?? [])],
    hiddenArtifactIds: [...(base.hiddenArtifactIds ?? [])],
    packageDisabled: [...(base.packageDisabled ?? [])],
    typeSuppressed: [...(base.typeSuppressed ?? [])],
    showFewerPackageIds: { ...(base.showFewerPackageIds ?? {}) },
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
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key in next) continue;
    next[key] = value;
  }
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
  if (typeof payload?.scope === "string" && payload.scope.trim() !== "") return payload.scope;
  if (
    kind === "safe_package_setting_update" ||
    kind === "candidate_package_proposal" ||
    kind === "enable_package" ||
    kind === "pause_package" ||
    kind === "disable_package" ||
    kind === "tune_package" ||
    kind === "reset_package"
  ) {
    return `package:${targetRef}`;
  }
  return FEED_HOST_PREFERENCES_SCOPE;
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
      const packageId = packageIdFromTarget(targetRef, payload);
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
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (key in result) continue;
    result[key] = value;
  }
  return result;
}

function packageIdFromTarget(targetRef: string, payload: Record<string, unknown> | undefined): string | undefined {
  if (typeof payload?.packageId === "string" && payload.packageId.trim() !== "") return payload.packageId;
  if (targetRef.startsWith("package:")) return targetRef.slice("package:".length);
  return targetRef.includes("/") ? undefined : targetRef;
}

function projectionStateFromRow(row: ProjectionRow): FeedProjectionState {
  const reasonCodes = JSON.parse(row.reason_codes_json) as string[];
  return {
    artifactId: row.artifact_id,
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
    docMissing: row.visibility === "repair_only" || reasonCodes.includes("broken_ref") || reasonCodes.includes("source_unavailable"),
  };
}

function stripProjectionState(row: FeedProjectionState): FeedArtifactProjection {
  return {
    artifactId: row.artifactId,
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
}

function projectionSqlRow(row: FeedProjectionState): SqlStatement {
  return {
    sql: `INSERT OR REPLACE INTO feed_artifact_projection (
      artifact_id, rank_score, disposition, visibility, freshness_label, reason_codes_json,
      package_id, source_fingerprint, published_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.artifactId,
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

function generationRequestSql(request: FeedGenerationRequestRecord): SqlStatement {
  return {
    sql: `INSERT OR REPLACE INTO generation_request (
      request_id, reader_nonce, actor_id, status, scope_json, package_id, dedupe_key,
      prompt, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      request.requestId,
      request.readerNonce,
      request.actorId,
      request.status,
      JSON.stringify(request.scope),
      request.packageId,
      request.dedupeKey,
      request.prompt,
      request.expiresAt,
      request.createdAt,
      request.updatedAt,
    ],
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
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
