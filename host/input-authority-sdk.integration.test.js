import { afterEach, describe, expect, mock, test } from "bun:test";
import { Wallet } from "ethers";
import {
  NodeWasmBindings,
  TinyCloudNode,
} from "../../js-sdk-feed-share/packages/node-sdk/dist/index.js";
import { delegateInputAuthorityLocally } from "../web/src/inputAuthority.ts";
import { InputAuthorityRegistry } from "./input-authority.ts";
import { validateInputAuthorityDelegation } from "./delegation.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("approved TinyCloud SDK input-authority integration", () => {
  test("real SDK attenuates a received share and the exact child passes Host attach", async () => {
    globalThis.fetch = mock(async () => new Response(
      JSON.stringify({ activated: ["child"] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const host = "https://node.tinycloud.xyz";
    const browserBindings = new NodeWasmBindings();
    const hostBindings = new NodeWasmBindings();
    const browser = new TinyCloudNode({ host, wasmBindings: browserBindings });
    const feedHost = new TinyCloudNode({ host, wasmBindings: hostBindings });
    const owner = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
    const manager = browserBindings.createSessionManager();
    const shareKeyId = manager.createSessionKey("feed-input-parent");
    const shareKeyDid = manager.getDID(shareKeyId).split("#")[0];
    const shareKeyJwk = JSON.parse(manager.jwk(shareKeyId));
    const spaceId = `tinycloud:pkh:eip155:1:${owner.address}:applications`;
    const parentExpiry = new Date(Date.now() + 60 * 60 * 1000);
    const path = "xyz.tinycloud.listen/transcript/team-meeting";
    const prepared = browserBindings.prepareSession({
      abilities: { kv: { [path]: ["tinycloud.kv/get", "tinycloud.kv/list"] } },
      address: browserBindings.ensureEip55(owner.address),
      chainId: 1,
      domain: "feed.localhost",
      issuedAt: new Date().toISOString(),
      expirationTime: parentExpiry.toISOString(),
      spaceId,
      delegateUri: shareKeyDid,
    });
    const parentSession = browserBindings.completeSessionSetup({
      ...prepared,
      signature: await owner.signMessage(prepared.siwe),
    });
    const tc1Link = browser.sharing.encodeLink({
      version: 1,
      host,
      spaceId,
      path,
      keyDid: shareKeyDid,
      key: shareKeyJwk,
      delegation: {
        cid: parentSession.delegationCid,
        delegateDID: shareKeyDid,
        delegatorDID: `did:pkh:eip155:1:${owner.address}`,
        spaceId,
        path,
        actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
        expiry: parentExpiry,
        isRevoked: false,
        allowSubDelegation: true,
        authHeader: parentSession.delegationHeader.Authorization,
      },
    });
    const submission = await delegateInputAuthorityLocally({
      sdk: browser,
      tc1Link,
      sourceId: "team-meeting",
      displayName: "Team meeting",
      delegateDID: feedHost.did,
      expectedHost: host,
      actions: ["tinycloud.kv/get"],
      expiry: new Date(parentExpiry.getTime() - 1000).toISOString(),
    });
    expect(submission.portableDelegation).not.toContain(shareKeyJwk.d);
    expect(submission.portableDelegation).not.toContain(parentSession.delegationHeader.Authorization);
    const callerTransport = JSON.parse(submission.portableDelegation);
    callerTransport.delegatorDID = "did:key:zCallerMetadata";
    callerTransport.createdAt = "2026-01-01T00:00:00.000Z";

    const { actor, data } = fakeActor(`did:pkh:eip155:1:${owner.address}`);
    const registry = new InputAuthorityRegistry();
    const feedHostPrincipal = feedHost.did.split("#")[0];
    const attached = await registry.attach({
      actor,
      body: { ...submission, portableDelegation: JSON.stringify(callerTransport) },
      expectedAudienceDID: feedHostPrincipal,
      expectedHost: host,
      inspect: async ({ portableDelegation, expectedAudienceDID, expectedHost }) => {
        const inspected = validateInputAuthorityDelegation({
          serializedDelegation: portableDelegation,
          expectedDelegateDID: expectedAudienceDID,
          expectedHost,
        });
        const access = await feedHost.useDelegation(inspected.portableDelegation);
        expect(access.delegation.cid).toBe(inspected.childCid);
        const { portableDelegation: _portable, ...lineage } = inspected;
        return lineage;
      },
    });
    expect(attached).toMatchObject({
      sourceId: "team-meeting",
      state: "active",
      path,
      actions: ["tinycloud.kv/get"],
      parentCid: parentSession.delegationCid,
      agentDID: feedHostPrincipal,
    });
    const stored = JSON.stringify([...data.values()]);
    expect(stored).not.toContain("zCallerMetadata");
    expect(stored).not.toContain("2026-01-01T00:00:00.000Z");
    expect(stored).toContain(shareKeyDid);
  });
});

function fakeActor(actorId) {
  const data = new Map();
  return {
    actor: {
      actorId,
      settings: {
        kv: {
          get: async (key) => data.has(key)
            ? { ok: true, data: { data: data.get(key) } }
            : { ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } },
          put: async (key, value) => {
            data.set(key, value);
            return { ok: true };
          },
        },
      },
    },
    data,
  };
}
