// The node expires activation sessions on an hours timescale while the
// delegation chains stay valid for days. These tests pin the self-healing
// contract: an unauthorized result triggers exactly one re-activation from
// the stored delegations and a transparent retry — no user action.
import { expect, test } from "bun:test";
import { DELEGATED_ACCESS_TTL_MS, reactivateActorAccess, selfHealingAccess } from "./server.ts";
import type { FeedHostDelegationStore } from "./delegation-store.ts";

type Actor = Parameters<typeof selfHealingAccess>[0];
type Deps = Parameters<typeof reactivateActorAccess>[0];

const PATH = "xyz.tinycloud.artifacts/index";
const DELEGATE = "did:key:zHost";
const POLICY_HASH = "sha256:current-policy";
const UNAUTHORIZED = {
  ok: false,
  error: { message: "SQL query failed: 401 - Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:applications/sql/xyz.tinycloud.artifacts/index / tinycloud.sql/read" },
};

function makeAccess(session: { validGeneration: number }, generation: number) {
  const guard = async (result: unknown) =>
    generation >= session.validGeneration ? result : UNAUTHORIZED;
  return {
    sql: {
      db: () => ({
        query: (sql: string) => guard({ ok: true, data: { columns: [], rows: [[`gen-${generation}:${sql}`]] } }),
        batch: () => guard({ ok: true }),
        execute: () => guard({ ok: true }),
      }),
    },
    kv: {
      get: (key: string) => guard({ ok: true, data: { data: `kv-${generation}:${key}` } }),
      put: () => guard({ ok: true }),
      delete: () => guard({ ok: true }),
    },
  } as unknown as NonNullable<ReturnType<Actor["accessByResource"]["get"]>>;
}

function makeWorld() {
  const session = { validGeneration: 1 };
  let activations = 0;
  const activateDelegation: Deps["activateDelegation"] = async () => {
    activations += 1;
    return {
      actorId: "did:pkh:eip155:1:0xabc",
      acceptedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      resources: [PATH],
      portableDelegation: {},
      access: makeAccess(session, session.validGeneration),
    } as never;
  };
  const store = {
    load: async () => ({
      actorId: "did:pkh:eip155:1:0xabc",
      delegateDID: DELEGATE,
      policyHash: POLICY_HASH,
      resources: [{
        path: PATH,
        serializedDelegation: "serialized-blob",
        acceptedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }],
    }),
  } as unknown as FeedHostDelegationStore;

  const actor = {
    actorId: "did:pkh:eip155:1:0xabc",
    acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    resources: [PATH],
    accessByResource: new Map([[PATH, makeAccess(session, 1)]]),
  } as unknown as Actor;
  actor.heal = () => reactivateActorAccess(
    { delegationStore: store, activateDelegation, delegateDID: DELEGATE, policyHash: POLICY_HASH },
    actor,
  );
  return { session, actor, activations: () => activations, store };
}

test("an expired activation heals once and the retry succeeds", async () => {
  const world = makeWorld();
  const access = selfHealingAccess(world.actor, PATH);
  const db = (access.sql as { db: (p: string) => { query: (sql: string) => Promise<{ ok: boolean; data?: unknown }> } }).db(PATH);

  const healthy = await db.query("SELECT 1");
  expect(healthy.ok).toBe(true);

  world.session.validGeneration = 2; // node-side session expiry
  const healed = await db.query("SELECT 2");
  expect(healed.ok).toBe(true);
  expect(JSON.stringify(healed.data)).toContain("gen-2");
  expect(world.activations()).toBe(1);
});

test("concurrent unauthorized results share a single re-activation", async () => {
  const world = makeWorld();
  const access = selfHealingAccess(world.actor, PATH);
  const db = (access.sql as { db: (p: string) => { query: (sql: string) => Promise<{ ok: boolean }> } }).db(PATH);

  world.session.validGeneration = 2;
  const results = await Promise.all([db.query("a"), db.query("b"), db.query("c")]);
  expect(results.every((result) => result.ok)).toBe(true);
  expect(world.activations()).toBe(1);
});

test("kv operations heal through the same path", async () => {
  const world = makeWorld();
  const access = selfHealingAccess(world.actor, PATH);

  world.session.validGeneration = 2;
  const result = await (access.kv as { get: (key: string) => Promise<{ ok: boolean; data?: { data: string } }> }).get("some/key");
  expect(result.ok).toBe(true);
  expect(result.data?.data).toContain("kv-2");
});

test("kv operations default to the resource path requested from a shared access", async () => {
  const world = makeWorld();
  let receivedPrefix: unknown;
  const shared = world.actor.accessByResource.get(PATH)!;
  (shared.kv as unknown as { get: Function }).get = async (_key: string, options?: { prefix?: unknown }) => {
    receivedPrefix = options?.prefix;
    return { ok: true, data: { data: "scoped" } };
  };

  const access = selfHealingAccess(world.actor, PATH);
  await (access.kv as { get: (key: string) => Promise<unknown> }).get("some/key");
  expect(receivedPrefix).toBe(PATH);
});

test("when no stored delegation exists the original result surfaces", async () => {
  const world = makeWorld();
  const emptyStore = { load: async () => null } as unknown as FeedHostDelegationStore;
  world.actor.heal = () => reactivateActorAccess(
    { delegationStore: emptyStore, activateDelegation: async () => { throw new Error("unreachable"); }, delegateDID: DELEGATE, policyHash: POLICY_HASH },
    world.actor,
  );
  const access = selfHealingAccess(world.actor, PATH);
  const db = (access.sql as { db: (p: string) => { query: (sql: string) => Promise<{ ok: boolean; error?: { message: string } }> } }).db(PATH);

  world.session.validGeneration = 2;
  const result = await db.query("SELECT 1");
  expect(result.ok).toBe(false);
  expect(result.error?.message).toContain("Unauthorized Action");
});

test("access older than 50 minutes proactively re-activates before the next operation", async () => {
  const world = makeWorld();
  let now = 10_000;
  world.actor.accessActivatedAtMs = now;
  world.actor.accessNow = () => now;
  const access = selfHealingAccess(world.actor, PATH);
  const db = (access.sql as { db: (p: string) => { query: (sql: string) => Promise<{ ok: boolean }> } }).db(PATH);

  now += DELEGATED_ACCESS_TTL_MS - 1;
  expect((await db.query("still-fresh")).ok).toBe(true);
  expect(world.activations()).toBe(0);

  now += 1;
  expect((await db.query("refresh-now")).ok).toBe(true);
  expect(world.activations()).toBe(1);
});

test("TTL refresh rejects a changed delegatee DID without activating stale authority", async () => {
  const world = makeWorld();
  const staleStore = {
    load: async () => ({
      actorId: world.actor.actorId,
      delegateDID: "did:key:zDifferentHost",
      policyHash: POLICY_HASH,
      resources: [{
        path: PATH,
        serializedDelegation: "serialized-blob",
        acceptedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }],
    }),
  } as unknown as FeedHostDelegationStore;
  world.actor.accessActivatedAtMs = 0;
  world.actor.accessNow = () => DELEGATED_ACCESS_TTL_MS;
  world.actor.heal = () => reactivateActorAccess(
    { delegationStore: staleStore, activateDelegation: async () => { throw new Error("must not activate"); }, delegateDID: DELEGATE, policyHash: POLICY_HASH },
    world.actor,
  );

  const access = selfHealingAccess(world.actor, PATH);
  const db = (access.sql as { db: (p: string) => { query: (sql: string) => Promise<unknown> } }).db(PATH);
  await expect(db.query("blocked")).rejects.toMatchObject({ code: "delegation_stale" });
});

test("TTL refresh rejects a changed policy hash without activating stale authority", async () => {
  const world = makeWorld();
  const staleStore = {
    load: async () => ({
      actorId: world.actor.actorId,
      delegateDID: DELEGATE,
      policyHash: "sha256:old-policy",
      resources: [{
        path: PATH,
        serializedDelegation: "serialized-blob",
        acceptedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }],
    }),
  } as unknown as FeedHostDelegationStore;
  world.actor.accessActivatedAtMs = 0;
  world.actor.accessNow = () => DELEGATED_ACCESS_TTL_MS;
  world.actor.heal = () => reactivateActorAccess(
    { delegationStore: staleStore, activateDelegation: async () => { throw new Error("must not activate"); }, delegateDID: DELEGATE, policyHash: POLICY_HASH },
    world.actor,
  );

  const access = selfHealingAccess(world.actor, PATH);
  const db = (access.sql as { db: (p: string) => { query: (sql: string) => Promise<unknown> } }).db(PATH);
  await expect(db.query("blocked")).rejects.toMatchObject({ code: "delegation_stale" });
});

test("selfHealingAccess forwards execute params to the underlying access", async () => {
  const calls: unknown[][] = [];
  const access = {
    sql: {
      db: () => ({
        query: async () => ({ ok: true }),
        batch: async () => ({ ok: true }),
        execute: async (...args: unknown[]) => { calls.push(args); return { ok: true }; },
      }),
    },
    kv: { get: async () => ({ ok: true }), put: async () => ({ ok: true }), delete: async () => ({ ok: true }), list: async () => ({ ok: true, data: { keys: [] } }) },
  };
  const actor: any = { actorId: "did:test:exec", access, accessByResource: new Map([["p", access]]) };
  const healing: any = selfHealingAccess(actor, "p");
  await healing.sql.db("p").execute("UPDATE t SET a=? WHERE b=? AND c=? AND d=?", [1, 2, 3, 4]);
  expect(calls.length).toBe(1);
  expect(calls[0][1]).toEqual([1, 2, 3, 4]);
});
