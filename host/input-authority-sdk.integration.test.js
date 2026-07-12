import { afterEach, describe, expect, mock, test } from "bun:test";
import { Wallet } from "ethers";
import {
  NodeWasmBindings,
  TinyCloudNode,
} from "../../js-sdk-feed-share/packages/node-sdk/dist/index.js";
import { delegateInputAuthorityLocally } from "../web/src/inputAuthority.ts";
import { InputAuthorityRegistry } from "./input-authority.ts";
import { validateInputAuthorityDelegation } from "./delegation.ts";
import { createInputAuthorityInspector } from "./server.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("approved TinyCloud SDK input-authority integration", () => {
  test("real SDK attenuates a received share and the exact child passes Host attach", async () => {
    let registeredChildCid = "";
    globalThis.fetch = mock(async (request, init) => {
      if (String(request).endsWith("/info")) {
        return new Response(JSON.stringify({ protocol: 1, version: "test", features: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(request).endsWith("/delegation/status")) {
        const cid = JSON.parse(String(init?.body)).cid;
        const active = cid === registeredChildCid;
        return new Response(JSON.stringify({
          cid,
          status: active ? "active" : "not_found",
          exists: active,
          active,
          revoked: false,
          expired: false,
        }), { status: active ? 200 : 404, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ activated: ["child"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const host = "https://node.tinycloud.xyz";
    const browserBindings = new NodeWasmBindings();
    const hostBindings = new NodeWasmBindings();
    const browser = new TinyCloudNode({ host, wasmBindings: browserBindings });
    const hostWallet = Wallet.createRandom();
    const feedHost = new TinyCloudNode({
      host,
      wasmBindings: hostBindings,
      privateKey: hostWallet.privateKey,
    });
    await feedHost.signIn();
    const owner = Wallet.createRandom();
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
    registeredChildCid = JSON.parse(submission.portableDelegation).cid;
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
      inspect: createInputAuthorityInspector(feedHost),
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

    const original = JSON.parse(submission.portableDelegation);
    const mismatchedCid = {
      ...original,
      cid: "bafkr4iesnyviiybec3hbn63d2rdoavuu3s2n5pyz5gixl5pabqqnzazjfi",
    };
    expect(() => validateInputAuthorityDelegation({
      serializedDelegation: JSON.stringify(mismatchedCid),
      expectedDelegateDID: feedHostPrincipal,
      expectedHost: host,
      computeDelegationCid: (authorization) => feedHost.computeDelegationCid(authorization),
    })).toThrow("CID does not match");

    const token = original.delegationHeader.Authorization;
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    claims.prf.push(JSON.stringify({ parentBearer: "Bearer smuggled" }));
    const multiProofToken = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
    const multiProof = {
      ...original,
      cid: feedHost.computeDelegationCid(multiProofToken),
      delegationHeader: { Authorization: multiProofToken },
    };
    expect(() => validateInputAuthorityDelegation({
      serializedDelegation: JSON.stringify(multiProof),
      expectedDelegateDID: feedHostPrincipal,
      expectedHost: host,
      computeDelegationCid: (authorization) => feedHost.computeDelegationCid(authorization),
    })).toThrow("exactly one canonical parent proof");

    const forgedToken = `${header}.${payload}.${signature.slice(0, -1)}${signature.endsWith("a") ? "b" : "a"}`;
    const forgedCid = feedHost.computeDelegationCid(forgedToken);
    expect(forgedCid).not.toBe(registeredChildCid);
    const forgedTransport = JSON.stringify({
      ...original,
      cid: forgedCid,
      delegationHeader: { Authorization: forgedToken },
    });
    await expect(createInputAuthorityInspector(feedHost)({
      portableDelegation: forgedTransport,
      expectedAudienceDID: feedHostPrincipal,
      expectedHost: host,
    })).rejects.toMatchObject({ code: "input_authority_unavailable" });
    expect(await feedHost.getDelegationStatus(forgedCid)).toMatchObject({
      ok: true,
      data: { cid: forgedCid, status: "not_found", active: false },
    });
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
