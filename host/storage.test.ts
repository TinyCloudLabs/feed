import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FEED_HOST_ARTIFACT_DOC_PREFIX, FEED_HOST_ARTIFACTS_DB_PATH, FEED_HOST_FEED_DB_PATH } from "./delegation.ts";
import type { FeedHostActorStorage } from "./storage.ts";
import { FeedHostStorage } from "./storage.ts";
import type { FeedV1MigrationSummary } from "../../artifactory/skills/_shared/lib/feed-v1-migration.ts";
import type { FeedArtifact } from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import { feedV1MigrationApplyPlans } from "../../artifactory/skills/_shared/lib/feed-v1-schema.ts";
import { seedDefaultFeed } from "./seed.ts";
import {
  FEED_V1_LEGACY_PROJECTION_PARITY_SQL,
  FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL,
  FEED_V1_PREVIEW_TO_LEGACY_RECONCILIATION_SQL,
  FEED_POST_MIGRATION,
  FEED_GENERATION_WORKER_MIGRATION,
  withFeedHostMigrations,
} from "./feed-schema.ts";

// Real SDK failures surface as plain service-error objects, not Error instances.
const MULTI_RESOURCE_ERROR = {
  code: "NETWORK_ERROR",
  message:
    "SQL operation requires multiple permissions (tinycloud.sql/schema, tinycloud.sql/write) but this SDK runtime does not support multi-resource invocations",
  service: "sql",
};

type DbLog = { applies: number; batches: Array<Array<{ sql: string }>>; executes: string[] };

type LegacyFixture = {
  artifacts: Record<string, unknown>[];
  interactions: Record<string, unknown>[];
};

function makeActor(options: { batchFails?: boolean; legacyRows?: LegacyFixture } = {}): {
  actor: FeedHostActorStorage;
  logs: Map<string, DbLog>;
} {
  const logs = new Map<string, DbLog>();

  function makeDb(path: string) {
    const log: DbLog = { applies: 0, batches: [], executes: [] };
    logs.set(path, log);
    return {
      migrations: {
        apply: async () => {
          log.applies += 1;
          return { ok: false, error: MULTI_RESOURCE_ERROR };
        },
      },
      batch: async (statements: Array<{ sql: string }>) => {
        log.batches.push(statements);
        if (options.batchFails) return { ok: false, error: MULTI_RESOURCE_ERROR };
        return { ok: true };
      },
      execute: async (sql: string) => {
        log.executes.push(sql);
        return { ok: true };
      },
    };
  }

  function makeLegacyDb(kind: "artifact" | "interaction", rows: Record<string, unknown>[]) {
    return {
      query: async () => ({
        ok: true,
        data: {
          columns: rows.length > 0 ? Object.keys(rows[0]!) : [],
          rows,
          rowCount: rows.length,
        },
      }),
    };
  }

  const artifactDb = makeDb(FEED_HOST_ARTIFACTS_DB_PATH);
  const feedDb = makeDb(FEED_HOST_FEED_DB_PATH);
  const actor = {
    artifacts: { sql: { db: (path: string) => (path === FEED_HOST_ARTIFACTS_DB_PATH ? artifactDb : feedDb) } },
    feed: { sql: { db: (path: string) => (path === FEED_HOST_FEED_DB_PATH ? feedDb : artifactDb) } },
    documents: { kv: { put: async () => ({ ok: true }) } },
    ...(options.legacyRows
      ? {
          legacyArtifacts: { sql: { db: () => makeLegacyDb("artifact", options.legacyRows?.artifacts ?? []) } },
          legacyInteractions: { sql: { db: () => makeLegacyDb("interaction", options.legacyRows?.interactions ?? []) } },
        }
      : {}),
  } as unknown as FeedHostActorStorage;

  return { actor, logs };
}

test("bootstraps schema with per-migration batches when migrations.apply cannot mix actions", async () => {
  const { actor, logs } = makeActor();

  const storage = new FeedHostStorage();
  await storage.bootstrapSchema(actor);

  const artifactLog = logs.get(FEED_HOST_ARTIFACTS_DB_PATH);
  const feedLog = logs.get(FEED_HOST_FEED_DB_PATH);
  expect(artifactLog?.applies).toBe(1);
  expect(feedLog?.applies).toBe(1);
  expect(artifactLog?.batches.length).toBe(1);
  expect(feedLog?.batches.length).toBe(3);
  expect(artifactLog?.batches[0]?.length).toBe(7);
  expect(feedLog?.batches[0]?.length).toBe(6);
  expect(artifactLog?.batches[0]?.[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS artifact_index");
  expect(feedLog?.batches[0]?.[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS feed_artifact_projection");
  expect(feedLog?.batches[1]?.[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS feed_item_projection");
  expect(feedLog?.batches[1]?.some((statement) => statement.sql.includes("CREATE TABLE IF NOT EXISTS feed_targeted_interaction_event"))).toBe(true);
  expect(feedLog?.batches[2]?.some((statement) => statement.sql.includes("ADD COLUMN fencing_token"))).toBe(true);
  expect(artifactLog?.executes.length).toBe(0);
  expect(feedLog?.executes.length).toBe(2);
  expect(feedLog?.executes[0]).toContain("ON CONFLICT(feed_item_id) DO UPDATE");
});

test("converges with the canonical post migration without duplicating it", () => {
  const canonical = { ...FEED_POST_MIGRATION, description: "canonical Artifactory migration" };
  const merged = withFeedHostMigrations([
    { id: "001_feed_index", description: "base", sql: [] },
    canonical,
  ]);

  expect(merged.map((migration) => migration.id)).toEqual([
    "001_feed_index",
    "002_post_feed_items",
    "003_generation_worker_control",
  ]);
  expect(merged.filter((migration) => migration.id === "002_post_feed_items")).toHaveLength(1);
  expect(merged.find((migration) => migration.id === "002_post_feed_items")?.description).toBe(
    "canonical Artifactory migration",
  );
  expect(FEED_POST_MIGRATION.sql.join("\n")).toContain("'legacy:' || artifact_id");
  expect(FEED_POST_MIGRATION.sql.every((sql) => !sql.startsWith("ALTER TABLE"))).toBe(true);
  expect(FEED_GENERATION_WORKER_MIGRATION.sql).toContain(
    "ALTER TABLE generation_request ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0",
  );
});

test("reconciliation is monotonic, repairs both rollout directions, and closes the parity gate", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE feed_artifact_projection (
    artifact_id TEXT PRIMARY KEY, rank_score REAL NOT NULL, disposition TEXT NOT NULL,
    visibility TEXT NOT NULL, freshness_label TEXT NOT NULL, reason_codes_json TEXT NOT NULL,
    package_id TEXT NOT NULL, source_fingerprint TEXT NOT NULL,
    published_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  for (const sql of FEED_POST_MIGRATION.sql.slice(0, 2)) db.exec(sql);
  const insertLegacy = db.prepare(`INSERT OR REPLACE INTO feed_artifact_projection VALUES (?, ?, 'default', 'ranked', 'fresh', '[]', 'pkg', 'sha256:source', ?, ?)`);
  insertLegacy.run("late", 0.4, "2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
  db.exec(FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL);
  expect(db.query<{ feed_item_id: string }, []>("SELECT feed_item_id FROM feed_item_projection WHERE artifact_id = 'late'").get()?.feed_item_id).toBe("legacy:late");

  db.exec(`UPDATE feed_item_projection SET rank_score = 0.9, updated_at = '2026-07-03T00:00:00.000Z' WHERE feed_item_id = 'legacy:late'`);
  insertLegacy.run("late", 0.2, "2026-07-01T00:00:00.000Z", "2026-07-02T00:00:00.000Z");
  db.exec(FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL);
  expect(db.query<{ rank_score: number }, []>("SELECT rank_score FROM feed_item_projection WHERE feed_item_id = 'legacy:late'").get()?.rank_score).toBe(0.9);
  db.exec(FEED_V1_PREVIEW_TO_LEGACY_RECONCILIATION_SQL);
  expect(db.query<{ rank_score: number }, []>("SELECT rank_score FROM feed_artifact_projection WHERE artifact_id = 'late'").get()?.rank_score).toBe(0.9);

  insertLegacy.run("late", 0.7, "2026-07-01T00:00:00.000Z", "2026-07-04T00:00:00.000Z");
  db.exec(FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL);
  expect(db.query<{ rank_score: number }, []>("SELECT rank_score FROM feed_item_projection WHERE feed_item_id = 'legacy:late'").get()?.rank_score).toBe(0.7);
  const parity = db.query<{ mismatch_count: number }, []>(FEED_V1_LEGACY_PROJECTION_PARITY_SQL).get();
  expect(Number(parity?.mismatch_count)).toBe(0);

  db.exec(`UPDATE feed_item_projection SET published_at = '2026-07-09T00:00:00.000Z' WHERE feed_item_id = 'legacy:late'`);
  expect(Number(db.query<{ mismatch_count: number }, []>(FEED_V1_LEGACY_PROJECTION_PARITY_SQL).get()?.mismatch_count)).toBe(1);
  db.exec(FEED_V1_LEGACY_PROJECTION_RECONCILIATION_SQL);
  expect(Number(db.query<{ mismatch_count: number }, []>(FEED_V1_LEGACY_PROJECTION_PARITY_SQL).get()?.mismatch_count)).toBe(0);

  db.exec(`INSERT INTO feed_item_projection VALUES (
    'legacy:orphan', 'artifact_preview', 'orphan', NULL, 0.1, 'default', 'ranked',
    'fresh', '[]', 'pkg', 'sha256:orphan', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
  )`);
  expect(Number(db.query<{ mismatch_count: number }, []>(FEED_V1_LEGACY_PROJECTION_PARITY_SQL).get()?.mismatch_count)).toBe(1);
  db.close();
});

test("falls back to statement-by-statement execution when batches cannot mix actions either", async () => {
  const { actor, logs } = makeActor({ batchFails: true });

  const storage = new FeedHostStorage();
  await storage.bootstrapSchema(actor);

  const artifactLog = logs.get(FEED_HOST_ARTIFACTS_DB_PATH);
  const feedLog = logs.get(FEED_HOST_FEED_DB_PATH);
  const plans = feedV1MigrationApplyPlans();
  const artifactStatements = plans.find((plan) => plan.dbName === "artifacts_index")!.migrations.flatMap((migration) => migration.sql);
  const feedStatements = withFeedHostMigrations(
    plans.find((plan) => plan.dbName === "feed_index")!.migrations,
  ).flatMap((migration) => migration.sql);
  expect(artifactLog?.executes.length).toBe(artifactStatements.length);
  expect(feedLog?.executes.length).toBe(feedStatements.length + 2);
  expect(artifactLog?.executes[0]).toContain("CREATE TABLE IF NOT EXISTS artifact_index");
  expect(feedLog?.executes[0]).toContain("CREATE TABLE IF NOT EXISTS feed_artifact_projection");
  expect(feedLog?.executes[6]).toContain("CREATE TABLE IF NOT EXISTS feed_item_projection");
});

test("hydrates corrupt artifact docs defensively and audits invalid fixtures", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const storage = new FeedHostStorage();
    const malformed = {
      artifact_id: "malformed-artifact",
      artifact_type: "insight_card",
      package_id: "pkg-malformed",
      source_fingerprint: "sha256:malformed",
      doc_key: "seed/malformed.json",
      published_at: "2026-06-29T12:00:00.000Z",
      updated_at: "2026-06-29T12:00:00.000Z",
    } as const;
    const schemaMismatch = {
      artifact_id: "schema-mismatch-artifact",
      artifact_type: "insight_card",
      package_id: "pkg-schema",
      source_fingerprint: "sha256:schema",
      doc_key: "seed/schema-mismatch.json",
      published_at: "2026-06-29T12:01:00.000Z",
      updated_at: "2026-06-29T12:01:00.000Z",
    } as const;
    const actor = makeHydrationActor({
      artifacts: [malformed, schemaMismatch],
      docs: {
        [artifactDocKey(malformed.doc_key)]: "{not-json",
        [artifactDocKey(schemaMismatch.doc_key)]: {
          schemaVersion: "feed.artifact.v1",
          artifactId: "schema-mismatch-artifact",
        },
      },
    });

    const malformedRead = await storage.readArtifact(actor, "malformed-artifact");
    expect(malformedRead.kind).toBe("hydration_failed");

    const plan = await storage.reconcileFeedProjection(actor);
    expect(plan.upserts.map((row) => row.target.artifactId).sort()).toEqual(["malformed-artifact", "schema-mismatch-artifact"]);
    expect(plan.upserts.every((row) => row.visibility === "repair_only")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
  }
});

test("returns a feed page when one artifact document is temporarily unavailable", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const artifact = {
      artifact_id: "temporarily-unavailable",
      artifact_type: "insight_card",
      package_id: "pkg-timeout",
      source_fingerprint: "sha256:timeout",
      doc_key: "listen-import/timeout.json",
      published_at: "2026-07-14T12:00:00.000Z",
      updated_at: "2026-07-14T12:00:00.000Z",
    };
    const actor = makeHydrationActor({
      artifacts: [artifact],
      docs: {},
      docErrors: {
        [artifactDocKey(artifact.doc_key)]: {
          code: "NETWORK_ERROR",
          message: "Failed to acquire connection from pool: Connection pool timed out",
        },
      },
      projections: [{
        feed_item_id: artifact.artifact_id,
        target_kind: "artifact_preview",
        artifact_id: artifact.artifact_id,
        post_id: null,
        rank_score: 1,
        disposition: "default",
        visibility: "visible",
        freshness_label: "fresh",
        reason_codes_json: "[]",
        package_id: artifact.package_id,
        source_fingerprint: artifact.source_fingerprint,
        published_at: artifact.published_at,
        updated_at: artifact.updated_at,
      }],
    });

    const page = await new FeedHostStorage().listFeed(actor, { limit: 40 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.target.artifactId).toBe(artifact.artifact_id);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("rejects feedback for a missing artifact before writing either interaction table", async () => {
  const storage = new FeedHostStorage();
  const actor = makeHydrationActor({ artifacts: [], docs: {} });

  await expect(storage.recordFeedback(actor, {
    eventId: "dangling-artifact-feedback",
    actorId: actor.actorId,
    readerNonce: "dangling-artifact-feedback",
    target: { kind: "artifact", artifactId: "missing-artifact" },
    signal: "helpful",
    createdAt: "2026-07-11T12:00:00.000Z",
  })).rejects.toMatchObject({ status: 400, code: "invalid_feedback_target" });
});

function artifactDocKey(docKey: string): string {
  return `${FEED_HOST_ARTIFACT_DOC_PREFIX}/${docKey}`;
}

function makeHydrationActor(input: {
  artifacts: Array<{
    artifact_id: string;
    artifact_type: string;
    package_id: string;
    source_fingerprint: string;
    doc_key: string;
    published_at: string;
    updated_at: string;
  }>;
  docs: Record<string, unknown>;
  docErrors?: Record<string, { code: string; message: string }>;
  projections?: Record<string, unknown>[];
}): FeedHostActorStorage {
  const docs = new Map(Object.entries(input.docs));

  function makeDb(path: string) {
    return {
      migrations: {
        apply: async () => ({ ok: false, error: MULTI_RESOURCE_ERROR }),
      },
      query: async (sql: string, params: Array<string | number>) => {
        if (path === FEED_HOST_FEED_DB_PATH && sql.includes("artifact_index")) {
          throw new Error("feed_index queries must not join the distinct artifacts_index database");
        }
        if (path === FEED_HOST_ARTIFACTS_DB_PATH && sql.includes("WHERE artifact_id = ?")) {
          const artifactId = String(params[0]);
          return {
            ok: true,
            data: {
              columns: [],
              rows: input.artifacts.filter((row) => row.artifact_id === artifactId),
            },
          };
        }
        if (path === FEED_HOST_ARTIFACTS_DB_PATH && sql.includes("FROM artifact_index")) {
          return {
            ok: true,
            data: {
              columns: [],
              rows: input.artifacts,
            },
          };
        }
        if (path === FEED_HOST_FEED_DB_PATH && sql.includes("FROM feed_artifact_projection")) {
          return {
            ok: true,
            data: {
              columns: [],
              rows: [],
            },
          };
        }
        if (path === FEED_HOST_FEED_DB_PATH && sql.includes("FROM feed_item_projection")) {
          return {
            ok: true,
            data: {
              columns: [],
              rows: input.projections ?? [],
            },
          };
        }
        return {
          ok: true,
          data: {
            columns: [],
            rows: [],
          },
        };
      },
      batch: async () => ({ ok: true }),
      execute: async () => ({ ok: true }),
    };
  }

  return {
    actorId: "did:pkh:eip155:1:0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed",
    artifacts: { sql: { db: (path: string) => makeDb(path) } },
    feed: { sql: { db: (path: string) => makeDb(path) } },
    documents: {
      kv: {
        get: async (key: string) =>
          input.docErrors?.[key]
            ? { ok: false, error: input.docErrors[key] }
            : docs.has(key)
            ? { ok: true, data: { data: docs.get(key) } }
            : { ok: false, error: { code: "KV_NOT_FOUND", message: `not found: ${key}` } },
        put: async () => ({ ok: true }),
      },
    },
    settings: {
      kv: {
        put: async () => ({ ok: true }),
      },
    },
  } as unknown as FeedHostActorStorage;
}

test("invokes the legacy migration hook once per actor during bootstrap", async () => {
  const { actor } = makeActor();
  let migrateCalls = 0;
  const storage = new FeedHostStorage({
    migrateLegacyData: async () => {
      migrateCalls += 1;
      return emptyMigrationSummary();
    },
  });

  await storage.bootstrapSchema(actor);
  await storage.bootstrapSchema(actor);

  expect(migrateCalls).toBe(1);
});

test("bootstraps legacy rows when the actor can read the old SQL resources", async () => {
  const { actor, logs } = makeActor({
    legacyRows: {
      artifacts: [
        {
          id: "legacy-card-1",
          type: "article",
          render_type: "article",
          slug: "legacy-card-1",
          headline: "Legacy headline",
          body_md: "Legacy body.",
          source_transcripts: JSON.stringify(["listen-1"]),
          raw_artifact: JSON.stringify({
            producer: { run_id: "run-legacy-1" },
          }),
          generated_at: "2026-06-01T10:00:00.000Z",
          published_at: "2026-06-01T11:00:00.000Z",
          publisher_did: "did:pkh:eip155:1:0x1234567890abcdef1234567890abcdef12345678",
          schema_version: 1,
        },
      ],
      interactions: [],
    },
  });

  const storage = new FeedHostStorage();
  const summary = await storage.bootstrapSchema(actor);

  expect(summary.legacyArtifacts).toBe(1);
  expect(summary.migratedArtifacts).toBe(1);
  expect(summary.migratedArtifactDocs).toBe(1);
  expect(summary.migratedArtifactRows).toBe(1);
  expect(summary.migratedFeedRows).toBe(1);
  expect(summary.skippedArtifacts).toBe(0);
  expect(summary.skippedInteractions).toBe(0);

  const artifactLog = logs.get(FEED_HOST_ARTIFACTS_DB_PATH);
  const feedLog = logs.get(FEED_HOST_FEED_DB_PATH);
  expect(artifactLog?.batches.length).toBe(2);
  expect(feedLog?.batches.length).toBe(4);
  expect(artifactLog?.batches[0]?.[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS artifact_index");
  expect(feedLog?.batches[0]?.[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS feed_artifact_projection");
  expect(artifactLog?.batches[1]?.[0]?.sql).toContain("INSERT OR REPLACE INTO artifact_index");
  expect(feedLog?.batches[3]?.[0]?.sql).toContain("INSERT OR REPLACE INTO feed_item_projection");
});

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

test("seeds the canonical rich artifact at its declared document path", async () => {
  const documentKeys: string[] = [];
  const seedRows: Array<{ dbName: string; rows: Array<{ table: string; values: Record<string, string | number | null> }> }> = [];
  const hostStorage = new FeedHostStorage();
  const storage = {
    insertSeedRows: async (
      _actor: FeedHostActorStorage,
      dbName: string,
      rows: Array<{ table: string; values: Record<string, string | number | null> }>,
    ) => {
      seedRows.push({ dbName, rows });
    },
    writeArtifactDocument: async (actor: FeedHostActorStorage, artifact: FeedArtifact) =>
      hostStorage.writeArtifactDocument(actor, artifact),
  } as unknown as FeedHostStorage;
  const actor = {
    documents: {
      kv: {
        put: async (key: string) => {
          documentKeys.push(key);
          return { ok: true, data: undefined };
        },
      },
    },
  } as unknown as FeedHostActorStorage;

  await seedDefaultFeed(storage, actor);

  expect(
    seedRows
      .find(({ dbName }) => dbName === "artifacts_index")
      ?.rows.find((row) => row.table === "artifact_index")?.values.doc_key,
  ).toBe("runs/run-weekly-product-brief/brief.json");
  expect(documentKeys).toEqual(["xyz.tinycloud.artifacts/artifacts/runs/run-weekly-product-brief/brief.json"]);
});
