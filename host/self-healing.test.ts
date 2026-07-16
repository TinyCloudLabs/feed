// The node expires activation sessions on an hours timescale while the
// delegation chains stay valid for days. These tests pin the self-healing
// contract: an unauthorized result triggers exactly one re-activation from
// the stored delegations and a transparent retry — no user action.
import { expect, test } from "bun:test";
import { reactivateActorAccess, selfHealingAccess } from "./server.ts";
import type { FeedHostDelegationStore } from "./delegation-store.ts";

type Actor = Parameters<typeof selfHealingAccess>[0];
type Deps = Parameters<typeof reactivateActorAccess>[0];

const PATH = "xyz.tinycloud.artifacts/index";
const DELEGATE = "did:key:zHost";
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
    { delegationStore: store, activateDelegation, delegateDID: DELEGATE },
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

test("when no stored delegation exists the original result surfaces", async () => {
  const world = makeWorld();
  const emptyStore = { load: async () => null } as unknown as FeedHostDelegationStore;
  world.actor.heal = () => reactivateActorAccess(
    { delegationStore: emptyStore, activateDelegation: async () => { throw new Error("unreachable"); }, delegateDID: DELEGATE },
    world.actor,
  );
  const access = selfHealingAccess(world.actor, PATH);
  const db = (access.sql as { db: (p: string) => { query: (sql: string) => Promise<{ ok: boolean; error?: { message: string } }> } }).db(PATH);

  world.session.validGeneration = 2;
  const result = await db.query("SELECT 1");
  expect(result.ok).toBe(false);
  expect(result.error?.message).toContain("Unauthorized Action");
});
