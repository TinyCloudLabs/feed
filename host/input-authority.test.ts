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
    const view = await registry.attach({
      actor,
      body: { sourceId: "team-listen", displayName: "Team Listen", portableDelegation: "child-portable-ucan" },
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
    expect(JSON.stringify(view)).not.toContain("child-portable-ucan");
    expect(JSON.stringify(view)).not.toContain("tc1:");
    expect(JSON.stringify([...data.values()])).toContain("child-portable-ucan");
    expect([...data.keys()]).toEqual([
      `xyz.tinycloud.feed/settings/input-authorities/${encodeURIComponent(ACTOR.toLowerCase())}.json`,
    ]);
  });

  test("supports multiple named sources and revoke, expire, unavailable, and remove states", async () => {
    let now = NOW;
    const { actor } = fakeActor(ACTOR);
    const registry = new InputAuthorityRegistry(() => now);
    for (const sourceId of ["team", "personal"]) {
      await registry.attach({
        actor,
        body: { sourceId, displayName: sourceId, portableDelegation: `child-${sourceId}` },
        expectedAudienceDID: HOST_DID,
        expectedHost: HOST,
        inspect: async () => inspection(),
      });
    }
    expect((await registry.list(actor)).map((item) => item.sourceId)).toEqual(["team", "personal"]);
    expect((await registry.revoke(actor, "team")).state).toBe("revoked");
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
