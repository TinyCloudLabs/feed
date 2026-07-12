import { describe, expect, test } from "bun:test";
import {
  FEED_HOST_DELEGATION_RESOURCES,
  FeedDelegationError,
  validateFeedHostDelegation,
} from "./delegation.ts";

const HOST_DID = "did:key:z6MkpMJ78htgF6SFFCaFGLAHx82XN7dtivuDW1hfnA7idxrA";
const OWNER = "eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const SPACE = `tinycloud:pkh:${OWNER}:applications`;

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

// One signed UCAN whose att claim carries every (service, path, actions)
// entry — the shape the SDK's multi-entry delegateTo emits.
function multiResourceDelegation(input?: {
  omitPaths?: string[];
  dropActionsFor?: string;
  expiry?: string;
  delegateDID?: string;
}): string {
  const att: Record<string, Record<string, unknown[]>> = {};
  for (const resource of FEED_HOST_DELEGATION_RESOURCES) {
    if (input?.omitPaths?.includes(resource.path)) continue;
    const abilities: Record<string, unknown[]> = {};
    for (const action of resource.actions) {
      if (input?.dropActionsFor === resource.path && action !== resource.actions[0]) continue;
      abilities[action] = [];
    }
    att[`${SPACE}/${resource.service}/${resource.path}`] = abilities;
  }
  const jwt = `${base64url(JSON.stringify({ alg: "EdDSA" }))}.${base64url(JSON.stringify({ att }))}.${base64url("sig")}`;
  return JSON.stringify({
    delegateDID: input?.delegateDID ?? HOST_DID,
    expiry: input?.expiry ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    delegationHeader: { Authorization: `Bearer ${jwt}` },
    cid: "bafy-multi-resource-test",
  });
}

describe("validateFeedHostDelegation (multi-resource UCAN)", () => {
  test("accepts a single delegation covering the full policy and binds the signed owner", () => {
    const accepted = validateFeedHostDelegation({
      serializedDelegation: multiResourceDelegation(),
      expectedDelegateDID: HOST_DID,
    });
    expect(accepted.resources.sort()).toEqual(FEED_HOST_DELEGATION_RESOURCES.map((resource) => resource.path).sort());
    expect(accepted.actorId).toBe(`did:pkh:${OWNER}`);
  });

  test("accepts a partial delegation but only reports the covered resources", () => {
    const omitted = FEED_HOST_DELEGATION_RESOURCES[0].path;
    const accepted = validateFeedHostDelegation({
      serializedDelegation: multiResourceDelegation({ omitPaths: [omitted] }),
      expectedDelegateDID: HOST_DID,
    });
    expect(accepted.resources).not.toContain(omitted);
    expect(accepted.resources).toHaveLength(FEED_HOST_DELEGATION_RESOURCES.length - 1);
  });

  test("rejects a delegation whose grant is missing required actions", () => {
    const target = FEED_HOST_DELEGATION_RESOURCES[0].path;
    expect(() =>
      validateFeedHostDelegation({
        serializedDelegation: multiResourceDelegation({ dropActionsFor: target }),
        expectedDelegateDID: HOST_DID,
      }),
    ).toThrow(FeedDelegationError);
  });

  test("rejects a delegation minted for a different delegate", () => {
    expect(() =>
      validateFeedHostDelegation({
        serializedDelegation: multiResourceDelegation({ delegateDID: "did:key:z6Mkother" }),
        expectedDelegateDID: HOST_DID,
      }),
    ).toThrow(FeedDelegationError);
  });

  test("rejects an expired delegation", () => {
    expect(() =>
      validateFeedHostDelegation({
        serializedDelegation: multiResourceDelegation({ expiry: new Date(Date.now() - 1000).toISOString() }),
        expectedDelegateDID: HOST_DID,
      }),
    ).toThrow(FeedDelegationError);
  });
});
