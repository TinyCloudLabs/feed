import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { IDatabaseHandle, SqlValue } from "@tinycloud/node-sdk";
import { feedV1MigrationApplyPlans } from "../../artifactory/skills/_shared/lib/feed-v1-schema.ts";
import { withFeedHostMigrations } from "./feed-schema.ts";
import {
  ensureProactiveGenerationRequest,
  proactiveDedupeKey,
  ProactiveDailyScheduler,
  PROACTIVE_PROMPT,
} from "./proactive-scheduler.ts";
import { FeedHostStorage, type FeedHostActorStorage } from "./storage.ts";

const ACTOR_ID = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function realQueue(maxPendingGenerationRequests = 8): {
  db: Database;
  actor: FeedHostActorStorage;
  storage: FeedHostStorage;
  close: () => void;
} {
  const db = new Database(":memory:");
  const plan = feedV1MigrationApplyPlans().find((candidate) => candidate.dbName === "feed_index")!;
  for (const migration of withFeedHostMigrations(plan.migrations)) {
    for (const sql of migration.sql) db.exec(sql);
  }
  const handle = {
    query: async (sql: string, params: SqlValue[] = []) => {
      const rows = db.query(sql).all(...params) as Record<string, unknown>[];
      return { ok: true, data: { columns: rows[0] ? Object.keys(rows[0]) : [], rows, rowCount: rows.length } };
    },
    execute: async (sql: string, params: SqlValue[] = []) => {
      const result = db.query(sql).run(...params);
      return { ok: true, data: { changes: result.changes } };
    },
    batch: async (statements: Array<{ sql: string; params?: SqlValue[] }>) => {
      for (const statement of statements) db.query(statement.sql).run(...(statement.params ?? []));
      return { ok: true, data: [] };
    },
  } as unknown as IDatabaseHandle;
  const access = { sql: { db: () => handle } };
  return {
    db,
    actor: { actorId: ACTOR_ID, feed: access } as unknown as FeedHostActorStorage,
    storage: new FeedHostStorage({ maxPendingGenerationRequests }),
    close: () => db.close(),
  };
}

function scheduler(
  queue: ReturnType<typeof realQueue>,
  now: () => Date,
  logs: Array<Record<string, unknown>> = [],
): ProactiveDailyScheduler {
  return new ProactiveDailyScheduler({
    actorId: ACTOR_ID,
    now,
    ensureRequest: (event) => ensureProactiveGenerationRequest(queue.storage, queue.actor, event),
    log: (_level, event, fields) => logs.push({ event, ...fields }),
  });
}

function requestCount(db: Database): number {
  return Number(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM generation_request").get()?.count ?? 0);
}

test("daily proactive enqueue is one durable unscoped row across ticks, restarts, and terminal state", async () => {
  const queue = realQueue();
  const clock = () => new Date("2026-07-21T12:34:56.000Z");
  const logs: Array<Record<string, unknown>> = [];
  try {
    const firstProcess = scheduler(queue, clock, logs);
    expect(await firstProcess.ensureCurrentSlot()).toBe("ok");
    expect(await firstProcess.ensureCurrentSlot()).toBe("ok");

    const restartedProcess = scheduler(queue, clock, logs);
    expect(await restartedProcess.ensureCurrentSlot()).toBe("ok");
    expect(requestCount(queue.db)).toBe(1);

    const row = queue.db.query<{
      dedupe_key: string;
      scope_json: string;
      package_id: string | null;
      workflow_id: string | null;
      prompt: string | null;
    }, []>("SELECT dedupe_key, scope_json, package_id, workflow_id, prompt FROM generation_request").get()!;
    expect(row).toEqual({
      dedupe_key: "proactive:extract-insights:v1:2026-07-21",
      scope_json: JSON.stringify({ targetRef: "feed" }),
      package_id: null,
      workflow_id: null,
      prompt: PROACTIVE_PROMPT,
    });
    const payload = queue.db.query<{ payload_json: string }, []>(
      "SELECT payload_json FROM control_intent_event ORDER BY created_at DESC LIMIT 1",
    ).get()!;
    expect(JSON.parse(payload.payload_json)).toEqual({ prompt: PROACTIVE_PROMPT, proactive: true });

    queue.db.exec("UPDATE generation_request SET status = 'consumed', phase = 'published'");
    expect(await restartedProcess.ensureCurrentSlot()).toBe("ok");
    expect(requestCount(queue.db)).toBe(1);
    expect(logs).toHaveLength(4);
    expect(logs.every((entry) => entry.event === "proactive_enqueue" && entry.resultCode === "ok")).toBe(true);
  } finally {
    queue.close();
  }
});

test("today's slot is inserted after yesterday's request expires", async () => {
  const queue = realQueue();
  let now = new Date("2026-07-20T23:50:00.000Z");
  try {
    const daily = scheduler(queue, () => now);
    expect(await daily.ensureCurrentSlot()).toBe("ok");
    queue.db.exec("UPDATE generation_request SET expires_at = '2026-07-20T23:59:59.000Z', status = 'expired'");

    now = new Date("2026-07-21T00:05:00.000Z");
    expect(await daily.ensureCurrentSlot()).toBe("ok");
    expect(requestCount(queue.db)).toBe(2);
    const keys = queue.db.query<{ dedupe_key: string }, []>(
      "SELECT dedupe_key FROM generation_request ORDER BY created_at ASC",
    ).all().map((row) => row.dedupe_key);
    expect(keys).toEqual([
      "proactive:extract-insights:v1:2026-07-20",
      "proactive:extract-insights:v1:2026-07-21",
    ]);
  } finally {
    queue.close();
  }
});

test("backlog cap is reported as skipped and later ticks can retry", async () => {
  const queue = realQueue(1);
  let now = new Date("2026-07-21T08:00:00.000Z");
  try {
    await queue.storage.recordControlIntent(queue.actor, {
      eventId: "existing-user-ask",
      actorId: ACTOR_ID,
      readerNonce: "existing-user-ask-nonce",
      intentKind: "ask_feed",
      targetRef: "feed",
      payload: { prompt: "A user request already in the queue." },
      createdAt: now.toISOString(),
    });
    const daily = scheduler(queue, () => now);
    expect(await daily.ensureCurrentSlot()).toBe("skipped_backlog");
    expect(daily.snapshot()).toMatchObject({ lastEnsuredSlot: null, lastResult: "skipped_backlog" });
    expect(requestCount(queue.db)).toBe(1);

    queue.db.exec("UPDATE generation_request SET status = 'consumed'");
    now = new Date("2026-07-21T08:01:00.000Z");
    expect(await daily.ensureCurrentSlot()).toBe("ok");
    expect(requestCount(queue.db)).toBe(2);
  } finally {
    queue.close();
  }
});

test("disabled scheduler performs no writes", async () => {
  const queue = realQueue();
  let calls = 0;
  const daily = new ProactiveDailyScheduler({
    actorId: null,
    ensureRequest: async () => {
      calls += 1;
      return {};
    },
  });
  try {
    daily.start();
    expect(await daily.ensureCurrentSlot()).toBe("disabled");
    expect(daily.snapshot()).toEqual({
      enabled: false,
      actorHash: null,
      lastEnsuredSlot: null,
      lastResult: null,
    });
    expect(calls).toBe(0);
    expect(requestCount(queue.db)).toBe(0);
    expect(proactiveDedupeKey(new Date("2026-07-21T23:59:59.000Z"))).toBe(
      "proactive:extract-insights:v1:2026-07-21",
    );
  } finally {
    daily.stop();
    queue.close();
  }
});
