import type {
  DelegatedAccess,
  IDatabaseHandle,
  QueryResponse,
  SqlStatement,
  SqlValue,
} from "@tinycloud/node-sdk";
import type {
  ControlIntentEvent,
  FeedArtifact,
  FeedArtifactProjection,
  FeedbackEvent,
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
} from "./delegation.ts";

type ProjectionRow = {
  artifact_id: string;
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
  doc_key: string;
};

export type FeedHostActorStorage = {
  artifacts: DelegatedAccess;
  feed: DelegatedAccess;
  documents: DelegatedAccess;
  legacyArtifacts?: DelegatedAccess;
  legacyInteractions?: DelegatedAccess;
};

export type FeedHostStorageOptions = {
  migrateLegacyData?: (actor: FeedHostActorStorage) => Promise<FeedV1MigrationSummary>;
};

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
    const rows = await queryRows<ProjectionRow>(
      this.db(actor, "feed_index"),
      `SELECT artifact_id, rank_score, disposition, visibility, freshness_label, reason_codes_json,
              package_id, source_fingerprint, published_at, updated_at
         FROM feed_artifact_projection
        ORDER BY rank_score DESC, published_at DESC
        LIMIT ? OFFSET ?`,
      [limit + 1, offset],
    );
    const pageRows = rows.slice(0, limit);
    return {
      items: pageRows.map(projectionFromRow),
      nextCursor: rows.length > limit ? String(offset + limit) : undefined,
    };
  }

  async getArtifact(actor: FeedHostActorStorage, artifactId: string): Promise<FeedArtifact | null> {
    const rows = await queryRows<ArtifactIndexRow>(
      this.db(actor, "artifacts_index"),
      "SELECT artifact_id, doc_key FROM artifact_index WHERE artifact_id = ?",
      [artifactId],
    );
    const row = rows[0];
    if (!row) return null;
    const result = await actor.documents.kv.get<FeedArtifact | string>(artifactDocKey(row.doc_key));
    if (!result.ok) {
      if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") return null;
      throw new Error(`Failed to read artifact document: ${resultError(result)}`);
    }
    return typeof result.data.data === "string" ? JSON.parse(result.data.data) : result.data.data;
  }

  async getProvenance(
    actor: FeedHostActorStorage,
    artifactId: string,
  ): Promise<Pick<FeedArtifact, "artifactId" | "sourceRefs" | "producedBy" | "freshness" | "idempotency"> | null> {
    const artifact = await this.getArtifact(actor, artifactId);
    if (!artifact) return null;
    return {
      artifactId: artifact.artifactId,
      sourceRefs: artifact.sourceRefs,
      producedBy: artifact.producedBy,
      freshness: artifact.freshness,
      idempotency: artifact.idempotency,
    };
  }

  async recordFeedback(actor: FeedHostActorStorage, event: FeedbackEvent): Promise<void> {
    const statements: SqlStatement[] = [
      {
        sql: `INSERT OR REPLACE INTO feedback_event (
          event_id, artifact_id, reader_nonce, actor_id, signal, payload_json, payload_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          event.eventId,
          event.artifactId,
          event.readerNonce,
          event.actorId,
          event.signal,
          event.payload === undefined ? null : JSON.stringify(event.payload),
          event.payloadHash ?? null,
          event.createdAt,
        ],
      },
    ];
    const disposition = dispositionForSignal(event.signal);
    if (disposition) {
      statements.push({
        sql: `UPDATE feed_artifact_projection
              SET disposition = ?, updated_at = ?
            WHERE artifact_id = ?`,
        params: [disposition, event.createdAt, event.artifactId],
      });
    }
    await batch(this.db(actor, "feed_index"), statements);
  }

  async recordControlIntent(actor: FeedHostActorStorage, event: ControlIntentEvent): Promise<void> {
    const statements: SqlStatement[] = [
      {
        sql: `INSERT OR REPLACE INTO control_intent_event (
          event_id, reader_nonce, actor_id, intent_kind, status, target_ref, payload_hash, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          event.eventId,
          event.readerNonce,
          event.actorId,
          event.intentKind,
          event.status,
          event.targetRef,
          event.payloadHash ?? null,
          event.payload === undefined ? null : JSON.stringify(event.payload),
          event.createdAt,
        ],
      },
    ];
    if (event.intentKind === "ask_feed") {
      const expiresAt = new Date(Date.parse(event.createdAt) + 60 * 60 * 1000).toISOString();
      statements.push({
        sql: `INSERT OR REPLACE INTO generation_request (
          request_id, reader_nonce, actor_id, status, scope_json, package_id, dedupe_key,
          prompt, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          event.eventId,
          event.readerNonce,
          event.actorId,
          "accepted",
          JSON.stringify({ targetRef: event.targetRef }),
          null,
          event.payloadHash ?? null,
          promptFromPayload(event.payload),
          expiresAt,
          event.createdAt,
          event.createdAt,
        ],
      });
    }
    await batch(this.db(actor, "feed_index"), statements);
  }

  async debugState(actor: FeedHostActorStorage): Promise<{
    artifacts: number;
    projections: number;
    feedback: number;
    controlIntents: number;
    generationRequests: number;
  }> {
    const [artifacts, projections, feedback, controlIntents, generationRequests] = await Promise.all([
      count(this.db(actor, "artifacts_index"), "artifact_index"),
      count(this.db(actor, "feed_index"), "feed_artifact_projection"),
      count(this.db(actor, "feed_index"), "feedback_event"),
      count(this.db(actor, "feed_index"), "control_intent_event"),
      count(this.db(actor, "feed_index"), "generation_request"),
    ]);
    return { artifacts, projections, feedback, controlIntents, generationRequests };
  }

  private db(actor: FeedHostActorStorage, dbName: FeedV1SqlResourceName): IDatabaseHandle {
    const access = dbName === "artifacts_index" ? actor.artifacts : actor.feed;
    return access.sql.db(DB_PATHS[dbName]);
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

  // Hosted delegated sessions lack invokeAny, and migrations.apply always
  // batches schema DDL with its write-action bookkeeping insert. Retry with
  // plain per-migration batches: feed migrations are all DDL, so each batch
  // resolves to the single tinycloud.sql/schema action.
  for (const migration of input.migrations) {
    const batched = await db
      .batch(migration.sql.map((sql) => ({ sql })))
      .catch((error) => ({ ok: false as const, error }));
    if (batched.ok) continue;
    if (!multiResourceInvocationUnsupported(resultError(batched))) {
      return { ok: false, error: batched.error };
    }
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

function projectionFromRow(row: ProjectionRow): FeedArtifactProjection {
  return {
    artifactId: row.artifact_id,
    rankScore: Number(row.rank_score),
    disposition: row.disposition,
    visibility: row.visibility,
    freshnessLabel: row.freshness_label,
    reasonCodes: JSON.parse(row.reason_codes_json) as string[],
    packageId: row.package_id,
    sourceFingerprint: row.source_fingerprint,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
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

function promptFromPayload(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "prompt" in payload) {
    const prompt = (payload as { prompt?: unknown }).prompt;
    return typeof prompt === "string" ? prompt : null;
  }
  return null;
}

async function count(db: IDatabaseHandle, table: string): Promise<number> {
  const rows = await queryRows<{ count: number }>(db, `SELECT COUNT(*) AS count FROM ${identifier(table)}`);
  return Number(rows[0]?.count ?? 0);
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
