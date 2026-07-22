import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { IDatabaseHandle, SqlValue } from "@tinycloud/node-sdk";
import type { FeedArtifact, TranscriptSourceRef } from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import { FEED_GENERATION_WORKER_MIGRATION } from "./feed-schema.ts";
import { FeedHostStorage, type FeedHostActorStorage } from "./storage.ts";

const ACTOR_ID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000abc";
const T0 = "2026-07-20T00:00:00.000Z";
const T_HALF = "2026-07-20T00:00:30.000Z";
const T1 = "2026-07-20T00:01:00.000Z";
const T2 = "2026-07-20T00:02:00.000Z";
const SOURCE_REF: TranscriptSourceRef = {
  sourceRefId: "listen:conversation-1",
  sourceKind: "listen_conversation",
  sourceId: "conversation-1",
  observedPath: "kv_transcript",
  observedHash: "sha256:source-1",
  observedAt: T0,
};

describe("generation worker storage", () => {
  test("a claim race has one winner and the Host deterministically binds runId to requestId", async () => {
    const queue = makeQueue();
    queue.insert("request-race");
    const claims = await Promise.all([
      queue.storage.claimGenerationRequest(queue.actor, claim("workflow-a", "worker-a", T0, T1)),
      queue.storage.claimGenerationRequest(queue.actor, claim("workflow-a", "worker-b", T0, T1)),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)).toMatchObject({
      requestId: "request-race",
      runId: "request-race",
      workflowId: "workflow-a",
      fencingToken: 1,
      attemptCount: 1,
      status: "pending",
      phase: "running",
    });
    queue.close();
  });

  test("one live actor/workflow lease blocks a second request from reading the same unseen window", async () => {
    const queue = makeQueue();
    queue.insert("request-first");
    queue.insert("request-second", T_HALF);
    const first = await queue.storage.claimGenerationRequest(queue.actor, claim("workflow-serial", "worker-a", T0, T1));
    expect(first?.requestId).toBe("request-first");
    expect(await queue.storage.claimGenerationRequest(queue.actor, claim("workflow-serial", "worker-b", T_HALF, T2))).toBeNull();

    await queue.storage.publishGenerationArtifacts(queue.actor, {
      ...identity(first!), now: T_HALF, publicationKey: "publication-first", artifacts: [],
    });
    await queue.storage.reconcileGenerationRequest(queue.actor, { ...identity(first!), now: T_HALF });
    await queue.storage.completeGenerationRequest(queue.actor, {
      ...identity(first!), now: T_HALF, outcome: "zero_artifacts", cursor: { offset: 1 }, artifactIds: [],
    });
    expect(await queue.storage.claimGenerationRequest(queue.actor, claim("workflow-serial", "worker-b", T1, T2)))
      .toMatchObject({ requestId: "request-second", sourceCursorBefore: { offset: 1 } });
    queue.close();
  });

  test("a stored publication manifest resumes after restart and rejects the zombie fence", async () => {
    const queue = makeQueue();
    queue.insert("request-reclaim");
    const first = await queue.storage.claimGenerationRequest(queue.actor, claim("workflow-a", "worker-a", T0, T1));
    await queue.storage.updateGenerationRequestPhase(queue.actor, {
      ...identity(first!),
      now: T0,
      phase: "validating",
      metadata: { sourceRefs: [SOURCE_REF] },
    });
    const crossed = await queue.storage.publishGenerationArtifacts(queue.actor, {
      ...identity(first!),
      now: T_HALF,
      publicationKey: "publication-zero-1",
      artifacts: [],
    });
    expect(crossed).toMatchObject({ outcome: "zero_artifacts", request: { phase: "publishing" } });

    const restartedStorage = new FeedHostStorage();
    const reclaimed = await restartedStorage.claimGenerationRequest(
      queue.actor,
      claim("workflow-a", "worker-b", T2, "2026-07-20T00:03:00.000Z"),
    );
    expect(reclaimed).toMatchObject({ runId: "request-reclaim", claimOwner: "worker-b", fencingToken: 2, phase: "publishing" });
    expect(await restartedStorage.publishGenerationArtifacts(queue.actor, {
      ...identity(reclaimed!),
      now: T2,
    })).toMatchObject({ outcome: "zero_artifacts", publicationKey: "publication-zero-1" });

    await expect(queue.storage.heartbeatGenerationRequest(queue.actor, {
      ...identity(first!),
      now: T2,
      leaseExpiresAt: "2026-07-20T00:04:00.000Z",
    })).rejects.toMatchObject({ code: "stale_generation_lease", status: 409 });
    queue.close();
  });

  test("cancellation stops work before the manifest CAS but rolls forward afterward", async () => {
    const before = makeQueue();
    before.insert("cancel-before");
    const beforeClaim = await before.storage.claimGenerationRequest(before.actor, claim("workflow", "worker", T0, T1));
    await before.storage.requestGenerationCancellation(before.actor, { requestId: "cancel-before", now: T_HALF });
    expect(await before.storage.publishGenerationArtifacts(before.actor, {
      ...identity(beforeClaim!),
      now: T_HALF,
      publicationKey: "publication-cancelled",
      artifacts: [],
    })).toMatchObject({ outcome: "cancelled", request: { phase: "cancelled" } });
    before.close();

    const during = makeQueue();
    during.insert("cancel-during");
    const duringClaim = await during.storage.claimGenerationRequest(during.actor, claim("workflow", "worker", T0, T1));
    await during.storage.publishGenerationArtifacts(during.actor, {
      ...identity(duringClaim!),
      now: T_HALF,
      publicationKey: "publication-roll-forward",
      artifacts: [],
    });
    const cancellation = await during.storage.requestGenerationCancellation(during.actor, {
      requestId: "cancel-during",
      now: T_HALF,
    });
    expect(cancellation).toMatchObject({ cancellationRequested: true, status: "pending", phase: "publishing" });
    await during.storage.reconcileGenerationRequest(during.actor, { ...identity(duringClaim!), now: T_HALF });
    const completed = await during.storage.completeGenerationRequest(during.actor, {
      ...identity(duringClaim!),
      now: T_HALF,
      outcome: "zero_artifacts",
      cursor: { startedAt: T0, conversationId: "conversation-1" },
      artifactIds: [],
    });
    expect(completed).toMatchObject({ status: "consumed", phase: "zero_artifacts", cancellationRequested: true });
    during.close();
  });

  test("validated artifacts are checkpointed immutably before document/index writes", async () => {
    const queue = makeQueue();
    queue.insert("request-artifact");
    const request = await queue.storage.claimGenerationRequest(queue.actor, claim("workflow", "worker", T0, T1));
    await queue.storage.updateGenerationRequestPhase(queue.actor, {
      ...identity(request!),
      now: T0,
      phase: "validating",
      metadata: { sourceRefs: [SOURCE_REF] },
    });
    const artifact = feedArtifact("request-artifact", "artifact-1", "sha256:artifact-1");
    const published = await queue.storage.publishGenerationArtifacts(queue.actor, {
      ...identity(request!),
      now: T_HALF,
      publicationKey: "publication-artifact-1",
      artifacts: [artifact],
    });
    expect(published).toMatchObject({
      outcome: "published",
      artifactIds: ["artifact-1"],
      request: { publicationManifest: [{ artifactId: "artifact-1" }] },
    });
    expect(queue.documents.has("xyz.tinycloud.artifacts/artifacts/artifact-1.json")).toBe(true);

    await expect(queue.storage.publishGenerationArtifacts(queue.actor, {
      ...identity(request!),
      now: T_HALF,
      publicationKey: "publication-artifact-1",
      artifacts: [{ ...artifact, title: "changed after boundary" }],
    })).rejects.toMatchObject({ code: "publication_conflict", status: 409 });
    queue.close();
  });

  test("zero-output completion advances continuity and retry dead-letters at the stored limit", async () => {
    const queue = makeQueue();
    queue.insert("request-first");
    const first = await queue.storage.claimGenerationRequest(queue.actor, claim("workflow-continuity", "worker", T0, T1));
    await queue.storage.publishGenerationArtifacts(queue.actor, {
      ...identity(first!), now: T_HALF, publicationKey: "publication-first", artifacts: [],
    });
    await queue.storage.reconcileGenerationRequest(queue.actor, { ...identity(first!), now: T_HALF });
    const cursor = { startedAt: T0, conversationId: "conversation-1" };
    await queue.storage.completeGenerationRequest(queue.actor, {
      ...identity(first!), now: T_HALF, outcome: "zero_artifacts", cursor, artifactIds: [],
    });
    queue.insert("request-second", T1);
    const second = await queue.storage.claimGenerationRequest(queue.actor, claim("workflow-continuity", "worker", T1, T2));
    expect(second?.sourceCursorBefore).toEqual(cursor);

    const retryQueue = makeQueue();
    retryQueue.insert("request-retry");
    const retryFirst = await retryQueue.storage.claimGenerationRequest(retryQueue.actor, claim("workflow", "worker", T0, T1, 2));
    expect(await retryQueue.storage.retryGenerationRequest(retryQueue.actor, {
      ...identity(retryFirst!), now: T0, nextRetryAt: T1, error: { code: "provider_timeout" },
    })).toMatchObject({ status: "retry_wait", error: { code: "provider_timeout" } });
    const retrySecond = await retryQueue.storage.claimGenerationRequest(retryQueue.actor, claim("workflow", "worker", T1, T2, 2));
    expect(await retryQueue.storage.retryGenerationRequest(retryQueue.actor, {
      ...identity(retrySecond!), now: T1, nextRetryAt: T2, error: { code: "provider_timeout" },
    })).toMatchObject({ status: "dead_letter", phase: "dead_letter", nextRetryAt: null });
    const permanentQueue = makeQueue();
    permanentQueue.insert("request-permanent");
    const permanent = await permanentQueue.storage.claimGenerationRequest(
      permanentQueue.actor,
      claim("workflow", "worker", T0, T1, 3),
    );
    expect(await permanentQueue.storage.retryGenerationRequest(permanentQueue.actor, {
      ...identity(permanent!),
      now: T0,
      nextRetryAt: T1,
      retryable: false,
      error: { code: "invalid_workflow" },
    })).toMatchObject({ status: "dead_letter", phase: "dead_letter", nextRetryAt: null });
    queue.close();
    retryQueue.close();
    permanentQueue.close();
  });
});

function claim(workflowId: string, claimOwner: string, now: string, leaseExpiresAt: string, maxAttempts = 3) {
  return { workflowId, claimOwner, now, leaseExpiresAt, maxAttempts };
}

function identity(request: NonNullable<Awaited<ReturnType<FeedHostStorage["claimGenerationRequest"]>>>) {
  return { requestId: request.requestId, runId: request.runId!, claimOwner: request.claimOwner!, fencingToken: request.fencingToken };
}

function feedArtifact(runId: string, artifactId: string, artifactFingerprint: string): FeedArtifact {
  return {
    schemaVersion: "feed.artifact.v1",
    artifactId,
    artifactType: "insight",
    renderShape: "short_form",
    title: "A validated insight",
    body: { text: "Evidence-backed detail" },
    sourceRefs: [SOURCE_REF],
    producedBy: {
      packageId: "workflow",
      packageVersion: "1.0.0",
      packageDigest: "sha256:package",
      runId,
      runtimeClass: "feed_hosted",
      providerClass: "first_party",
      credentialOwner: "feed_hosted",
      egressClass: "model_provider",
      disclosure: {
        userCopy: "Uses the configured model provider.",
        credentialOwner: "feed_hosted",
        providerClass: "first_party",
        egressClass: "model_provider",
      },
    },
    freshness: { label: "fresh", asOf: T0 },
    idempotency: {
      sourceFingerprint: "sha256:source-1",
      artifactFingerprint,
      dedupeKey: "sha256:dedupe-1",
    },
    storage: { docKey: `${artifactId}.json` },
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeQueue(): {
  storage: FeedHostStorage;
  actor: FeedHostActorStorage;
  documents: Map<string, unknown>;
  insert: (requestId: string, createdAt?: string) => void;
  close: () => void;
} {
  const database = new Database(":memory:");
  database.exec(`CREATE TABLE generation_request (
    request_id TEXT PRIMARY KEY, reader_nonce TEXT NOT NULL, actor_id TEXT NOT NULL,
    status TEXT NOT NULL, scope_json TEXT NOT NULL, package_id TEXT, dedupe_key TEXT,
    prompt TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  for (const sql of FEED_GENERATION_WORKER_MIGRATION.sql) database.exec(sql);
  database.exec(`CREATE TABLE artifact_index (
    artifact_id TEXT PRIMARY KEY, artifact_type TEXT NOT NULL, package_id TEXT NOT NULL,
    package_version TEXT NOT NULL, package_digest TEXT NOT NULL, run_id TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL, artifact_fingerprint TEXT NOT NULL, dedupe_key TEXT NOT NULL,
    doc_key TEXT NOT NULL, media_keys_json TEXT NOT NULL, created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL, published_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE feed_artifact_projection (
    artifact_id TEXT PRIMARY KEY, rank_score REAL NOT NULL, disposition TEXT NOT NULL,
    visibility TEXT NOT NULL, freshness_label TEXT NOT NULL, reason_codes_json TEXT NOT NULL,
    package_id TEXT NOT NULL, source_fingerprint TEXT NOT NULL, published_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE feed_item_projection (
    feed_item_id TEXT PRIMARY KEY, target_kind TEXT NOT NULL, artifact_id TEXT NOT NULL, post_id TEXT,
    rank_score REAL NOT NULL, disposition TEXT NOT NULL, visibility TEXT NOT NULL,
    freshness_label TEXT NOT NULL, reason_codes_json TEXT NOT NULL, package_id TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL, published_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE control_intent_event (
    event_id TEXT PRIMARY KEY, reader_nonce TEXT NOT NULL, actor_id TEXT NOT NULL,
    intent_kind TEXT NOT NULL, status TEXT NOT NULL, target_ref TEXT NOT NULL,
    payload_hash TEXT, payload_json TEXT, created_at TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE projection_checkpoint (
    checkpoint_id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, artifact_cursor TEXT NOT NULL,
    last_reconciled_at TEXT NOT NULL, status TEXT NOT NULL
  )`);
  const handle = {
    query: async (sql: string, params: SqlValue[] = []) => {
      const rows = database.query(sql).all(...params) as Record<string, unknown>[];
      return { ok: true, data: { columns: rows[0] ? Object.keys(rows[0]) : [], rows, rowCount: rows.length } };
    },
    execute: async (sql: string, params: SqlValue[] = []) => {
      const result = database.query(sql).run(...params);
      return { ok: true, data: { changes: result.changes } };
    },
    batch: async (statements: Array<{ sql: string; params?: SqlValue[] }>) => {
      for (const statement of statements) database.query(statement.sql).run(...(statement.params ?? []));
      return { ok: true, data: [] };
    },
  } as unknown as IDatabaseHandle;
  const documents = new Map<string, unknown>();
  const access = {
    sql: { db: () => handle },
    kv: {
      put: async (key: string, value: unknown) => { documents.set(key, value); return { ok: true, data: {} }; },
      get: async (key: string) => documents.has(key)
        ? { ok: true, data: { data: documents.get(key) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } },
    },
  };
  const actor = { actorId: ACTOR_ID, feed: access, artifacts: access, settings: access, documents: access } as unknown as FeedHostActorStorage;
  return {
    storage: new FeedHostStorage(), actor, documents,
    insert: (requestId, createdAt = T0) => {
      database.query(`INSERT INTO generation_request (
        request_id, reader_nonce, actor_id, status, scope_json, prompt,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'accepted', '{}', ?, '2026-07-21T00:00:00.000Z', ?, ?)`)
        .run(requestId, `nonce-${requestId}`, ACTOR_ID, `prompt-${requestId}`, createdAt, createdAt);
    },
    close: () => database.close(),
  };
}

test("ask dedupe coalesces only onto live requests; nonce replays stay idempotent", async () => {
  const { storage, actor, close } = makeQueue();
  const base = {
    actorId: actor.actorId,
    intentKind: "generate_new_request" as const,
    targetRef: "feed",
    payload: { prompt: "same ask" },
    createdAt: new Date().toISOString(),
  };
  const first = await storage.recordControlIntent(actor, { ...base, eventId: crypto.randomUUID(), readerNonce: "n-1" });
  const dup = await storage.recordControlIntent(actor, { ...base, eventId: crypto.randomUUID(), readerNonce: "n-2" });
  expect(dup.requestId).toBe(first.requestId);

  await actor.feed.sql.db("xyz.tinycloud.feed/index").execute(
    "UPDATE generation_request SET expires_at = ? WHERE request_id = ?",
    [new Date(Date.now() - 1000).toISOString(), first.requestId],
  );
  const fresh = await storage.recordControlIntent(actor, { ...base, eventId: crypto.randomUUID(), readerNonce: "n-3", createdAt: new Date().toISOString() });
  expect(fresh.requestId).not.toBe(first.requestId);

  const replay = await storage.recordControlIntent(actor, { ...base, eventId: crypto.randomUUID(), readerNonce: "n-1" });
  expect(replay.requestId).toBe(first.requestId);

  await actor.feed.sql.db("xyz.tinycloud.feed/index").execute(
    "UPDATE generation_request SET status = 'consumed' WHERE request_id = ?",
    [fresh.requestId],
  );
  const after = await storage.recordControlIntent(actor, { ...base, eventId: crypto.randomUUID(), readerNonce: "n-4", createdAt: new Date().toISOString() });
  expect(after.requestId).not.toBe(fresh.requestId);
  close();
});
