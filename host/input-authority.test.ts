import { describe, expect, test } from "bun:test";
import {
  InputAuthorityRegistry,
  validateInspection,
  type InspectedInputAuthority,
} from "./input-authority.ts";
import type { FeedHostActorStorage } from "./storage.ts";

const ACTOR = "did:pkh:eip155:1:0x1111111111111111111111111111111111111111";
const OTHER_ACTOR = "did:pkh:eip155:1:0x2222222222222222222222222222222222222222";
const HOST_DID = "did:key:zFeedHost";
const HOST = "https://node.tinycloud.xyz";
const NOW = new Date("2026-07-20T00:00:00.000Z");

describe("named input authorities", () => {
  test("stores only a child delegation and returns redacted non-secret lineage", async () => {
    const { actor, data } = fakeActor(ACTOR);
    const registry = new InputAuthorityRegistry(() => NOW);
    const portableDelegation = childTransport({
      delegatorDID: "did:key:zCallerMetadata",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
    const view = await registry.attach({
      actor,
      body: { sourceId: "team-listen", displayName: "Team Listen", portableDelegation },
      expectedAudienceDID: HOST_DID,
      expectedHost: HOST,
      inspect: async () => inspection(),
    });

    expect(view).toMatchObject({
      sourceId: "team-listen",
      state: "active",
      hasPortableDelegation: true,
      path: "xyz.tinycloud.listen/conversations",
      parentCid: "bafy-parent",
      parentLineage: ["bafy-root", "bafy-parent"],
      agentDID: HOST_DID,
    });
    expect(JSON.stringify(view)).not.toContain("child.jwt.signature");
    expect(JSON.stringify(view)).not.toContain("tc1:");
    expect(JSON.stringify([...data.values()])).toContain("child.jwt.signature");
    expect(JSON.stringify([...data.values()])).not.toContain("zCallerMetadata");
    expect(JSON.stringify([...data.values()])).not.toContain("2026-07-18T00:00:00.000Z");
    expect(JSON.stringify([...data.values()])).toContain("did:key:zShare");
    expect([...data.keys()]).toEqual([
      `xyz.tinycloud.feed/settings/input-authorities/${encodeURIComponent(ACTOR.toLowerCase())}.json`,
    ]);
  });

  test("supports multiple named sources and revoke, expire, unavailable, and remove states", async () => {
    let now = NOW;
    const { actor } = fakeActor(ACTOR);
    const registry = new InputAuthorityRegistry(() => now);
    for (const sourceId of ["team", "personal"]) {
      const childCid = `bafy-${sourceId}`;
      await registry.attach({
        actor,
        body: { sourceId, displayName: sourceId, portableDelegation: childTransport({ cid: childCid }) },
        expectedAudienceDID: HOST_DID,
        expectedHost: HOST,
        inspect: async () => inspection({ childCid }),
      });
    }
    expect((await registry.list(actor, async () => "active")).map((item) => item.sourceId)).toEqual(["team", "personal"]);
    expect((await registry.revoke(actor, "team", async () => true)).state).toBe("revoked");
    expect((await registry.markUnavailable(actor, "personal", "upstream unavailable")).state).toBe("unavailable");
    now = new Date("2026-08-02T00:00:00.000Z");
    expect((await registry.get(actor, "personal")).state).toBe("expired");
    await registry.remove(actor, "team");
    expect((await registry.list(actor)).map((item) => item.sourceId)).toEqual(["personal"]);
  });

  test("rejects raw credentials before SDK inspection without echoing them", async () => {
    const { actor } = fakeActor(ACTOR);
    const registry = new InputAuthorityRegistry(() => NOW);
    let inspected = false;
    for (const body of [
      { sourceId: "raw", displayName: "Raw", portableDelegation: "child", tc1Link: "tc1:super-secret" },
      { sourceId: "raw", displayName: "Raw", portableDelegation: "child", clientPrivateJwk: { d: "secret" } },
      { sourceId: "raw", displayName: "Raw", portableDelegation: "child", parentBearer: "Bearer secret" },
      { sourceId: "raw", displayName: "Raw", portableDelegation: "tc1:super-secret" },
      { sourceId: "raw", displayName: JSON.stringify({ privateJwk: { d: "super-secret" } }), portableDelegation: childTransport() },
    ]) {
      const error = await registry.attach({
        actor,
        body,
        expectedAudienceDID: HOST_DID,
        expectedHost: HOST,
        inspect: async () => {
          inspected = true;
          return inspection();
        },
      }).catch((value) => value);
      expect(error).toMatchObject({ status: 400, code: "invalid_input_authority" });
      expect(String(error.message)).not.toContain("super-secret");
      expect(String(error.message)).not.toContain("Bearer secret");
    }
    expect(inspected).toBe(false);
  });

  test("rejects nested credential smuggling and re-delegatable children before inspection", async () => {
    const { actor } = fakeActor(ACTOR);
    const registry = new InputAuthorityRegistry(() => NOW);
    let inspections = 0;
    const valid = JSON.parse(childTransport()) as Record<string, unknown>;
    const resource = (valid.resources as Array<Record<string, unknown>>)[0]!;
    const cases = [
      { ...valid, publicDelegation: { ...valid } },
      { ...valid, companionDelegation: { ...valid } },
      { ...valid, delegationHeader: { ...(valid.delegationHeader as object), privateJwk: { d: "nested-secret" } } },
      { ...valid, resources: [{ ...resource, parentBearer: "Bearer nested-secret" }] },
      { ...valid, createdAt: JSON.stringify({ privateJwk: { d: "nested-secret" } }) },
      { ...valid, delegatorDID: "Bearer nested-secret" },
      { ...valid, disableSubDelegation: false },
      { ...valid, allowSubDelegation: true },
    ];
    for (const [index, child] of cases.entries()) {
      const error = await registry.attach({
        actor,
        body: { sourceId: `bad-${index}`, displayName: "Bad", portableDelegation: JSON.stringify(child) },
        expectedAudienceDID: HOST_DID,
        expectedHost: HOST,
        inspect: async () => {
          inspections += 1;
          return inspection();
        },
      }).catch((value) => value);
      expect(error).toMatchObject({ status: 400, code: "invalid_input_authority" });
      expect(String(error.message)).not.toContain("nested-secret");
    }
    expect(inspections).toBe(0);
  });

  test("uses TinyCloud truth for status and records revoke only after confirmation", async () => {
    const { actor } = fakeActor(ACTOR);
    const registry = new InputAuthorityRegistry(() => NOW);
    await registry.attach({
      actor,
      body: { sourceId: "team", displayName: "Team", portableDelegation: childTransport() },
      expectedAudienceDID: HOST_DID,
      expectedHost: HOST,
      inspect: async () => inspection(),
    });

    expect((await registry.get(actor, "team")).state).toBe("unavailable");
    expect((await registry.get(actor, "team", async () => "active")).state).toBe("active");
    await expect(registry.revoke(actor, "team", async () => false)).rejects.toMatchObject({
      status: 502,
      code: "input_authority_unavailable",
    });
    expect((await registry.get(actor, "team", async () => "active")).state).toBe("active");
    expect((await registry.revoke(actor, "team", async () => true)).state).toBe("revoked");
    expect((await registry.get(actor, "team", async () => "active")).state).toBe("revoked");
  });

  test("rejects wrong host, audience, broad permissions, expired, revoked, and cross-actor authority", () => {
    const cases: Array<[Partial<InspectedInputAuthority>, string]> = [
      [{ host: "https://evil.example" }, "wrong_host"],
      [{ audienceDID: "did:key:zOther", agentDID: "did:key:zOther" }, "wrong_audience"],
      [{ path: "xyz.tinycloud.listen/", actions: ["tinycloud.kv/read", "tinycloud.kv/write"] }, "broad_permissions"],
      [{ expiry: "2026-07-19T00:00:00.000Z" }, "input_authority_expired"],
      [{ revoked: true }, "input_authority_revoked"],
      [{ actorId: OTHER_ACTOR }, "actor_mismatch"],
    ];
    for (const [overrides, code] of cases) {
      expect(() => validateInspection(inspection(overrides), {
        actorId: ACTOR,
        expectedAudienceDID: HOST_DID,
        expectedHost: HOST,
        now: NOW,
      })).toThrow();
      try {
        validateInspection(inspection(overrides), {
          actorId: ACTOR,
          expectedAudienceDID: HOST_DID,
          expectedHost: HOST,
          now: NOW,
        });
      } catch (error) {
        expect(error).toMatchObject({ code });
      }
    }
  });
});

function inspection(overrides: Partial<InspectedInputAuthority> = {}): InspectedInputAuthority {
  return {
    childCid: "bafy-child",
    canonicalPortableDelegation: childTransport({ cid: overrides.childCid ?? "bafy-child" }),
    actorId: ACTOR,
    audienceDID: HOST_DID,
    host: HOST,
    space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications",
    path: "xyz.tinycloud.listen/conversations",
    actions: ["tinycloud.sql/read"],
    expiry: "2026-08-01T00:00:00.000Z",
    parentCid: "bafy-parent",
    parentLineage: ["bafy-root", "bafy-parent"],
    agentDID: HOST_DID,
    ...overrides,
  };
}

function childTransport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    cid: "bafy-child",
    delegateDID: HOST_DID,
    delegatorDID: "did:key:zShare",
    spaceId: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications",
    path: "xyz.tinycloud.listen/conversations",
    actions: ["tinycloud.sql/read"],
    expiry: "2026-08-01T00:00:00.000Z",
    isRevoked: false,
    allowSubDelegation: false,
    parentCid: "bafy-parent",
    createdAt: "2026-07-19T00:00:00.000Z",
    delegationHeader: { Authorization: "child.jwt.signature" },
    ownerAddress: "0x1111111111111111111111111111111111111111",
    chainId: 1,
    host: HOST,
    resources: [{
      service: "tinycloud.sql",
      space: "tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:applications",
      path: "xyz.tinycloud.listen/conversations",
      actions: ["tinycloud.sql/read"],
    }],
    disableSubDelegation: true,
    ...overrides,
  });
}

function fakeActor(actorId: string): { actor: FeedHostActorStorage; data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const kv = {
    get: async (key: string) => data.has(key)
      ? { ok: true as const, data: { data: data.get(key) } }
      : { ok: false as const, error: { code: "KV_NOT_FOUND", message: "not found" } },
    put: async (key: string, value: unknown) => {
      data.set(key, value);
      return { ok: true as const, data: undefined };
    },
    delete: async (key: string) => {
      data.delete(key);
      return { ok: true as const, data: undefined };
    },
  };
  return {
    actor: { actorId, settings: { kv } } as unknown as FeedHostActorStorage,
    data,
  };
}
