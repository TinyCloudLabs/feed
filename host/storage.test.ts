import { expect, test } from "bun:test";
import { FEED_HOST_ARTIFACTS_DB_PATH, FEED_HOST_FEED_DB_PATH } from "./delegation.ts";
import type { FeedHostActorStorage } from "./storage.ts";
import { FeedHostStorage } from "./storage.ts";
import type { FeedV1MigrationSummary } from "../../artifactory/skills/_shared/lib/feed-v1-migration.ts";

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
  expect(feedLog?.batches.length).toBe(1);
  expect(artifactLog?.batches[0]?.length).toBe(7);
  expect(feedLog?.batches[0]?.length).toBe(6);
  expect(artifactLog?.batches[0]?.[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS artifact_index");
  expect(feedLog?.batches[0]?.[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS feed_artifact_projection");
  expect(artifactLog?.executes.length).toBe(0);
  expect(feedLog?.executes.length).toBe(0);
});

test("falls back to statement-by-statement execution when batches cannot mix actions either", async () => {
  const { actor, logs } = makeActor({ batchFails: true });

  const storage = new FeedHostStorage();
  await storage.bootstrapSchema(actor);

  const artifactLog = logs.get(FEED_HOST_ARTIFACTS_DB_PATH);
  const feedLog = logs.get(FEED_HOST_FEED_DB_PATH);
  expect(artifactLog?.executes.length).toBe(7);
  expect(feedLog?.executes.length).toBe(6);
  expect(artifactLog?.executes[0]).toContain("CREATE TABLE IF NOT EXISTS artifact_index");
  expect(feedLog?.executes[0]).toContain("CREATE TABLE IF NOT EXISTS feed_artifact_projection");
});

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
  expect(feedLog?.batches.length).toBe(2);
  expect(artifactLog?.batches[0]?.[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS artifact_index");
  expect(feedLog?.batches[0]?.[0]?.sql).toContain("CREATE TABLE IF NOT EXISTS feed_artifact_projection");
  expect(artifactLog?.batches[1]?.[0]?.sql).toContain("INSERT OR REPLACE INTO artifact_index");
  expect(feedLog?.batches[1]?.[0]?.sql).toContain("INSERT OR REPLACE INTO feed_artifact_projection");
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
