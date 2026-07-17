import { describe, expect, test } from "bun:test";
import { delegateInputAuthorityLocally, receivedShareDelegationAvailable } from "./inputAuthority.ts";

describe("browser input authority SDK boundary", () => {
  test("calls sharing.delegateReceivedShare and returns only the child delegation", async () => {
    const calls: unknown[][] = [];
    const submission = await delegateInputAuthorityLocally({
      sdk: {
        sharing: {
          delegateReceivedShare: async (...args) => {
            calls.push(args);
            return {
              ok: true,
              data: {
                delegation: {
                  cid: "bafy-child",
                  delegateDID: "did:key:zFeedHost",
                  expiry: new Date("2026-08-01T00:00:00.000Z"),
                },
              },
            };
          },
        },
      },
      tc1Link: "tc1:parent-secret",
      sourceId: "team",
      displayName: "Team Listen",
      delegateDID: "did:key:zFeedHost",
      path: "xyz.tinycloud.listen/conversations",
      actions: ["tinycloud.sql/read"],
      expiry: "2026-08-01T00:00:00.000Z",
      expectedHost: "https://node.tinycloud.xyz",
    });

    expect(calls).toEqual([["tc1:parent-secret", {
      delegateDID: "did:key:zFeedHost",
      path: "xyz.tinycloud.listen/conversations",
      actions: ["tinycloud.sql/read"],
      expiry: new Date("2026-08-01T00:00:00.000Z"),
      expectedHost: "https://node.tinycloud.xyz",
    }]]);
    expect(submission).toMatchObject({ sourceId: "team", displayName: "Team Listen" });
    expect(JSON.parse(submission.portableDelegation)).toMatchObject({ cid: "bafy-child", delegateDID: "did:key:zFeedHost" });
    expect(JSON.stringify(submission)).not.toContain("parent-secret");
  });

  test("feature-detects an outdated SDK and redacts SDK failures", async () => {
    expect(receivedShareDelegationAvailable({ sharing: {} })).toBe(false);
    await expect(delegateInputAuthorityLocally({
      sdk: { sharing: {} },
      tc1Link: "tc1:parent-secret",
      sourceId: "team",
      displayName: "Team",
      delegateDID: "did:key:zFeedHost",
    })).rejects.toThrow("TinyCloud SDK update required");
    const sdkFailure = new Error("tc1:parent-secret");
    const delegation = delegateInputAuthorityLocally({
      sdk: { sharing: { delegateReceivedShare: async () => { throw sdkFailure; } } },
      tc1Link: "tc1:parent-secret",
      sourceId: "team",
      displayName: "Team",
      delegateDID: "did:key:zFeedHost",
    });
    await expect(delegation).rejects.toThrow("TinyCloud could not delegate the received share");
    await delegation.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("parent-secret");
      expect((error as Error).cause).toEqual(sdkFailure);
    });
  });
});
