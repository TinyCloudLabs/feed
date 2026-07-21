import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  clearTinyCloudDebugLogs,
  enableTinyCloudDebug,
  getTinyCloudDebugLogs,
  tinyCloudDebugLogger,
  type DelegatedAccess,
  type SqlValue,
} from "@tinycloud/node-sdk";
import {
  LISTEN_CONVERSATIONS_DB_PATH,
  MAX_LISTEN_SOURCE_BATCH_BYTES,
  MAX_LISTEN_SOURCE_ITEM_BYTES,
  parseListenSourceCursor,
  readListenSourceBatch,
  readListenSourceBatchWithTelemetry,
} from "./listen-source.ts";

const ACTOR_ID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000abc";
const opened: Database[] = [];

afterEach(() => {
  for (const database of opened.splice(0)) database.close();
});

describe("Listen source batches", () => {
  test("uses the exact full SQL path, excludes empty transcripts, and continues with a keyset cursor", async () => {
    const world = makeWorld();
    world.insert("conversation-new", "Newest", "2026-07-21T12:00:00.000Z", "");
    world.insert("conversation-kv", "KV source", "2026-07-21T11:00:00.000Z", "inline should lose");
    world.transcripts.set("conversation-kv", [{ speaker_name: "A", text: "KV transcript body" }]);
    world.insert("conversation-inline", "Inline source", "2026-07-21T10:00:00.000Z", "Inline transcript body");
    world.insert("conversation-old", "Old source", "2026-07-21T09:00:00.000Z", "Old transcript body");

    const first = await readListenSourceBatch({
      sqlAccess: world.sqlAccess,
      transcriptAccess: world.transcriptAccess,
      limit: 2,
    });
    expect(world.databasePaths).toEqual([LISTEN_CONVERSATIONS_DB_PATH]);
    expect(world.sqlStatements.some((statement) => /^\s*PRAGMA\b/i.test(statement))).toBe(false);
    expect(first.items.map((item) => item.conversationId)).toEqual(["conversation-kv", "conversation-inline"]);
    expect(first.items[0]?.transcript).toBe("A: KV transcript body");
    expect(first.nextCursor).toEqual({
      startedAt: "2026-07-21T10:00:00.000Z",
      conversationId: "conversation-inline",
    });

    const second = await readListenSourceBatch({
      sqlAccess: world.sqlAccess,
      transcriptAccess: world.transcriptAccess,
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((item) => item.conversationId)).toEqual(["conversation-old"]);
    expect(second.nextCursor).toBeNull();
  });

  test("enforces per-item and aggregate UTF-8 transcript byte caps", async () => {
    const world = makeWorld();
    const oversized = "🙂".repeat(MAX_LISTEN_SOURCE_ITEM_BYTES);
    for (let index = 0; index < 5; index += 1) {
      world.insert(`large-${index}`, `Large ${index}`, `2026-07-21T0${9 - index}:00:00.000Z`, oversized);
    }

    const batch = await readListenSourceBatch({
      sqlAccess: world.sqlAccess,
      transcriptAccess: world.transcriptAccess,
      limit: 10,
    });
    expect(batch.items).toHaveLength(3);
    expect(batch.items.every((item) => item.truncated)).toBe(true);
    expect(batch.items.every((item) => item.transcriptBytes <= MAX_LISTEN_SOURCE_ITEM_BYTES)).toBe(true);
    expect(batch.bytes).toBeLessThanOrEqual(MAX_LISTEN_SOURCE_BATCH_BYTES);
    expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBe(batch.bytes);
    expect(batch.nextCursor).not.toBeNull();
  });

  test("caps the complete JSON body when transcript characters require escaping", async () => {
    const world = makeWorld();
    world.insert(
      "escaped-source",
      "Escaped controls",
      "2026-07-21T12:00:00.000Z",
      "\u0001".repeat(MAX_LISTEN_SOURCE_BATCH_BYTES),
    );

    const batch = await readListenSourceBatch({
      sqlAccess: world.sqlAccess,
      transcriptAccess: world.transcriptAccess,
      limit: 1,
    });
    expect(batch.items).toHaveLength(1);
    expect(batch.items[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBe(batch.bytes);
    expect(batch.bytes).toBeLessThanOrEqual(MAX_LISTEN_SOURCE_BATCH_BYTES);
  });

  test("filters oversized conversation IDs before scan accounting or cursor construction", async () => {
    const world = makeWorld();
    const oversizedPrefix = "x".repeat(513);
    for (let index = 0; index < 100; index += 1) {
      world.insert(
        `${oversizedPrefix}-${index}`,
        `Oversized ${index}`,
        "2026-07-21T12:00:00.000Z",
        "must never enter a source batch",
      );
    }
    world.insert("valid-after-oversized", "Valid", "2026-07-21T11:00:00.000Z", "valid transcript");

    const batch = await readListenSourceBatch({
      sqlAccess: world.sqlAccess,
      transcriptAccess: world.transcriptAccess,
      limit: 1,
    });
    expect(batch.items.map((item) => item.conversationId)).toEqual(["valid-after-oversized"]);
    expect(parseListenSourceCursor(batch.nextCursor)).toEqual({
      startedAt: "2026-07-21T11:00:00.000Z",
      conversationId: "valid-after-oversized",
    });
    expect(batch.bytes).toBeLessThanOrEqual(MAX_LISTEN_SOURCE_BATCH_BYTES);
    expect(world.sqlStatements[0]).toContain('length("id") <= ?');

    const continuation = await readListenSourceBatch({
      sqlAccess: world.sqlAccess,
      transcriptAccess: world.transcriptAccess,
      limit: 1,
      cursor: batch.nextCursor ?? undefined,
    });
    expect(continuation.items).toEqual([]);
    expect(continuation.nextCursor).toBeNull();
  });

  test("rejects malformed cursor timestamps before they reach SQL", () => {
    expect(() => parseListenSourceCursor({
      startedAt: "not-a-timestamp".repeat(100),
      conversationId: "conversation-1",
    })).toThrow("source cursor startedAt is invalid");
  });

  test("does not fall back to inline data when delegated transcript access is unauthorized", async () => {
    const world = makeWorld();
    world.insert("unauthorized-source", "Denied", "2026-07-21T12:00:00.000Z", "inline must not bypass authority");
    const denied = {
      kv: {
        get: async () => ({
          ok: false,
          error: { code: "AUTH_UNAUTHORIZED", message: "Unauthorized Action" },
        }),
      },
    } as unknown as DelegatedAccess;
    await expect(readListenSourceBatch({
      sqlAccess: world.sqlAccess,
      transcriptAccess: denied,
    })).rejects.toMatchObject({ status: 403, code: "source_access_denied" });
  });

  test("source-batch telemetry contains only hashed identity and aggregate sizes", async () => {
    const world = makeWorld();
    const rawId = "conversation-private-raw-id";
    const privateText = "private transcript phrase that must stay out of telemetry";
    world.insert(rawId, "Private title", "2026-07-21T12:00:00.000Z", privateText);
    const lines: string[] = [];
    const prior = process.env.FEED_HOST_LOG;
    const priorDebug = process.env.TinyCloud_debug;
    const original = console.log;
    const originalDebug = console.debug;
    process.env.FEED_HOST_LOG = "1";
    process.env.TinyCloud_debug = "1";
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.debug = (...args: unknown[]) => lines.push(args.map((value) => JSON.stringify(value)).join(" "));
    enableTinyCloudDebug({ persist: false });
    clearTinyCloudDebugLogs();
    const transcriptAccess = {
      kv: {
        get: async (key: string) => {
          tinyCloudDebugLogger.log("service.request", { service: "kv", action: "get", key });
          return { ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } };
        },
      },
    } as unknown as DelegatedAccess;
    try {
      const batch = await readListenSourceBatchWithTelemetry({
        actorId: ACTOR_ID,
        sqlAccess: world.sqlAccess,
        transcriptAccess,
      });
      expect(batch.items[0]?.transcript).toBe(privateText);
      lines.push(JSON.stringify(getTinyCloudDebugLogs()));
    } finally {
      console.log = original;
      console.debug = originalDebug;
      if (prior === undefined) delete process.env.FEED_HOST_LOG;
      else process.env.FEED_HOST_LOG = prior;
      if (priorDebug === undefined) delete process.env.TinyCloud_debug;
      else process.env.TinyCloud_debug = priorDebug;
    }
    const serialized = lines.join("\n");
    expect(serialized).toContain('"event":"storage_span"');
    expect(serialized).toContain('"op":"listen_source_batch"');
    expect(serialized).toContain('"batchCount":1');
    expect(serialized).not.toContain(ACTOR_ID);
    expect(serialized).not.toContain(rawId);
    expect(serialized).not.toContain("Private title");
    expect(serialized).not.toContain(privateText);
  });

  test("failed source-batch spans retain zeroed batch metrics", async () => {
    const world = makeWorld();
    world.insert("denied-conversation", "Denied", "2026-07-21T12:00:00.000Z", "private fallback");
    const denied = {
      kv: {
        get: async () => ({ ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "Unauthorized Action" } }),
      },
    } as unknown as DelegatedAccess;
    const lines: string[] = [];
    const prior = process.env.FEED_HOST_LOG;
    const original = console.log;
    process.env.FEED_HOST_LOG = "1";
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    try {
      await expect(readListenSourceBatchWithTelemetry({
        actorId: ACTOR_ID,
        sqlAccess: world.sqlAccess,
        transcriptAccess: denied,
      })).rejects.toMatchObject({ status: 403, code: "source_access_denied" });
    } finally {
      console.log = original;
      if (prior === undefined) delete process.env.FEED_HOST_LOG;
      else process.env.FEED_HOST_LOG = prior;
    }
    const serialized = lines.join("\n");
    expect(serialized).toContain('"event":"storage_span"');
    expect(serialized).toContain('"batchCount":0');
    expect(serialized).toContain('"batchBytes":0');
    expect(serialized).not.toContain("denied-conversation");
    expect(serialized).not.toContain("private fallback");
  });
});

function makeWorld(): {
  sqlAccess: DelegatedAccess;
  transcriptAccess: DelegatedAccess;
  transcripts: Map<string, unknown>;
  databasePaths: string[];
  sqlStatements: string[];
  insert: (id: string, title: string, startedAt: string, transcriptText: string) => void;
} {
  const database = new Database(":memory:");
  opened.push(database);
  database.exec(`CREATE TABLE conversation (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    started_at TEXT,
    transcript_json TEXT,
    transcript_text TEXT
  )`);
  const databasePaths: string[] = [];
  const sqlStatements: string[] = [];
  const handle = {
    query: async (sql: string, params: SqlValue[] = []) => {
      sqlStatements.push(sql);
      try {
        const rows = database.query(sql).all(...params) as Record<string, unknown>[];
        return {
          ok: true,
          data: { columns: rows[0] ? Object.keys(rows[0]) : [], rows, rowCount: rows.length },
        };
      } catch (error) {
        return { ok: false, error: { code: "SQL", message: String(error) } };
      }
    },
  };
  const transcripts = new Map<string, unknown>();
  const sqlAccess = {
    sql: {
      db: (path: string) => {
        databasePaths.push(path);
        return handle;
      },
    },
  } as unknown as DelegatedAccess;
  const transcriptAccess = {
    kv: {
      get: async (key: string) => transcripts.has(key)
        ? { ok: true, data: { data: transcripts.get(key) } }
        : { ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } },
    },
  } as unknown as DelegatedAccess;
  return {
    sqlAccess,
    transcriptAccess,
    transcripts,
    databasePaths,
    sqlStatements,
    insert: (id, title, startedAt, transcriptText) => {
      database.query("INSERT INTO conversation (id, title, started_at, transcript_text) VALUES (?, ?, ?, ?)")
        .run(id, title, startedAt, transcriptText);
    },
  };
}
