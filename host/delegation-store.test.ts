import { describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import {
  FeedHostDelegationStore,
  liveDelegationResources,
  type StoredFeedDelegationRecord,
} from "./delegation-store.ts";

const ACTOR_ID = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function fakeStoreNode(): { node: TinyCloudNode; data: Map<string, unknown>; signIns: () => number } {
  const data = new Map<string, unknown>();
  let signIns = 0;
  const node = {
    signIn: async () => {
      signIns += 1;
      return {};
    },
    kv: {
      put: async (key: string, value: unknown) => {
        data.set(key, value);
        return { ok: true, data: undefined };
      },
      get: async (key: string) =>
        data.has(key)
          ? { ok: true, data: { data: data.get(key) } }
          : { ok: false, error: { code: "KV_NOT_FOUND", message: `not found: ${key}` } },
      delete: async (key: string) => {
        data.delete(key);
        return { ok: true, data: undefined };
      },
    },
  } as unknown as TinyCloudNode;
  return { node, data, signIns: () => signIns };
}

function record(overrides: Partial<StoredFeedDelegationRecord> = {}): StoredFeedDelegationRecord {
  return {
    actorId: ACTOR_ID,
    delegateDID: "did:pkh:eip155:1:0xHost",
    resources: [
      {
        path: "xyz.tinycloud.artifacts/index",
        serializedDelegation: "serialized-artifacts",
        acceptedAt: "2026-07-01T00:00:00.000Z",
        expiresAt: "2026-07-08T00:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("FeedHostDelegationStore", () => {
  test("round-trips a persisted delegation record through the host KV space", async () => {
    const { node, data, signIns } = fakeStoreNode();
    const store = new FeedHostDelegationStore(node);

    await store.save(record());
    // Keys use the normalized actor id so did:pkh address casing never forks records.
    expect([...data.keys()]).toEqual([`delegations/${ACTOR_ID.toLowerCase()}`]);

    const loaded = await store.load(ACTOR_ID);
    expect(loaded).toEqual(record());
    expect(await store.load(ACTOR_ID.toLowerCase())).toEqual(record());
    expect(signIns()).toBe(1);

    await store.remove(ACTOR_ID);
    expect(await store.load(ACTOR_ID)).toBeNull();
  });

  test("returns null for missing and malformed records", async () => {
    const { node, data } = fakeStoreNode();
    const store = new FeedHostDelegationStore(node);

    expect(await store.load(ACTOR_ID)).toBeNull();

    data.set(`delegations/${ACTOR_ID.toLowerCase()}`, { serialized: "legacy-shape" });
    expect(await store.load(ACTOR_ID)).toBeNull();
  });

  test("rejects actor ids that would escape the delegations prefix", async () => {
    const { node } = fakeStoreNode();
    const store = new FeedHostDelegationStore(node);
    expect(store.load("../delegations/other")).rejects.toThrow(/invalid actor id/);
    expect(store.load("a/b")).rejects.toThrow(/invalid actor id/);
  });

  test("liveDelegationResources drops expired and unparsable expiries", () => {
    const now = new Date("2026-07-02T00:00:00.000Z");
    const stored = record({
      resources: [
        {
          path: "xyz.tinycloud.artifacts/index",
          serializedDelegation: "live",
          acceptedAt: "2026-07-01T00:00:00.000Z",
          expiresAt: "2026-07-08T00:00:00.000Z",
        },
        {
          path: "xyz.tinycloud.feed/index",
          serializedDelegation: "expired",
          acceptedAt: "2026-06-01T00:00:00.000Z",
          expiresAt: "2026-06-08T00:00:00.000Z",
        },
        {
          path: "xyz.tinycloud.artifacts/artifacts",
          serializedDelegation: "broken",
          acceptedAt: "2026-06-01T00:00:00.000Z",
          expiresAt: "not-a-date",
        },
      ],
    });
    expect(liveDelegationResources(stored, now).map((resource) => resource.serializedDelegation)).toEqual([
      "live",
    ]);
  });

  test("reports count-only diagnostics for observed delegation records", async () => {
    const { node } = fakeStoreNode();
    const store = new FeedHostDelegationStore(node);
    await store.save(record({
      resources: [
        { path: "one", serializedDelegation: "secret-one", acceptedAt: "2026-07-01T00:00:00.000Z", expiresAt: "2026-07-02T12:00:00.000Z" },
        { path: "two", serializedDelegation: "secret-two", acceptedAt: "2026-07-01T00:00:00.000Z", expiresAt: "2026-07-10T00:00:00.000Z" },
      ],
    }));

    const stats = store.stats(new Date("2026-07-02T00:00:00.000Z"));
    expect(stats).toEqual({ actors: 1, resources: 2, expiringSoon: 1 });
    expect(JSON.stringify(stats)).not.toContain("secret");
    expect(JSON.stringify(stats)).not.toContain(ACTOR_ID);
  });
});
