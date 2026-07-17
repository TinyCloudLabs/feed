import { describe, expect, test } from "bun:test";
import {
  isMissingParentDelegationError,
  recoverMissingParentDelegation,
} from "./missingParentDelegation.ts";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  attachReceivedInputAuthority,
  overrideFeedAuthForTest,
} from "./auth.ts";
import { FeedReconnectRequiredError } from "./authPolicy.ts";
import type { FeedHostDelegationPolicy } from "./delegation.ts";
import type { FeedV1HostClient } from "./feedV1HostClient.ts";
import type { ConnectWalletResult } from "./openkey.ts";

const POLICY: FeedHostDelegationPolicy = {
  delegateDID: "did:key:zFeedHost",
  resources: [],
};

function wallet(canSignSilently: () => Promise<boolean>): ConnectWalletResult {
  return {
    address: "0xfeed",
    keyId: "key-feed",
    web3Provider: {} as ConnectWalletResult["web3Provider"],
    canSignSilently,
  };
}

function inputAuthoritySession(input: {
  delegate: () => Promise<unknown>;
  signIn?: () => Promise<void>;
  signOut?: () => Promise<void>;
}): TinyCloudWeb {
  return {
    did: "did:key:zReader",
    sharing: { delegateReceivedShare: input.delegate },
    signIn: input.signIn ?? (async () => undefined),
    signOut: input.signOut ?? (async () => undefined),
  } as unknown as TinyCloudWeb;
}

function childDelegation() {
  return {
    ok: true,
    data: {
      delegation: {
        cid: "bafy-child",
        delegateDID: POLICY.delegateDID,
        expiry: new Date("2026-08-01T00:00:00.000Z"),
      },
    },
  };
}

function authorityInput(client: FeedV1HostClient) {
  return {
    client,
    policy: POLICY,
    sourceId: "team",
    displayName: "Team Listen",
    tc1Link: "tc1:parent-secret",
  };
}

describe("missing parent delegation detection", () => {
  test("matches the observed activation failure and wrapped variants", () => {
    expect(isMissingParentDelegationError(
      new Error("Failed to activate delegation with host: Cannot find parent delegation"),
    )).toBe(true);
    expect(isMissingParentDelegationError(
      new Error("submission failed", {
        cause: new Error("CANNOT FIND PARENT DELEGATION"),
      }),
    )).toBe(true);
    expect(isMissingParentDelegationError({
      body: JSON.stringify({ error: { code: "missing_parent_delegation" } }),
    })).toBe(true);
  });

  test("does not match generic authorization or network errors", () => {
    expect(isMissingParentDelegationError(new Error("401 UNAUTHORIZED"))).toBe(false);
    expect(isMissingParentDelegationError(new Error("Failed to fetch"))).toBe(false);
    expect(isMissingParentDelegationError({ status: 401, body: "unauthorized" })).toBe(false);
    expect(isMissingParentDelegationError(new Error("Cannot find delegation"))).toBe(false);
  });
});

describe("missing parent delegation recovery", () => {
  test("clears through the shared helper and heals after one retry", async () => {
    let clears = 0;
    let reauthentications = 0;
    let retries = 0;
    const outcomes: string[] = [];

    const result = await recoverMissingParentDelegation({
      initialError: new Error("Cannot find parent delegation"),
      clearSession: async () => { clears += 1; },
      reauthenticateSilently: async () => {
        reauthentications += 1;
        return true;
      },
      retry: async () => {
        retries += 1;
        return "ready";
      },
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(result).toEqual({ status: "healed", value: "ready" });
    expect({ clears, reauthentications, retries }).toEqual({ clears: 1, reauthentications: 1, retries: 1 });
    expect(outcomes).toEqual(["healed"]);
  });

  test("stops after a second missing-parent failure and requires reconnect", async () => {
    let clears = 0;
    let retries = 0;
    const outcomes: string[] = [];

    const result = await recoverMissingParentDelegation({
      initialError: new Error("Cannot find parent delegation"),
      clearSession: async () => { clears += 1; },
      reauthenticateSilently: async () => true,
      retry: async () => {
        retries += 1;
        throw new Error("Failed to activate delegation with host: Cannot find parent delegation");
      },
      onOutcome: (outcome) => outcomes.push(outcome),
    });

    expect(result.status).toBe("reconnect_required");
    expect(retries).toBe(1);
    expect(clears).toBe(2);
    expect(outcomes).toEqual(["reconnect_required"]);
  });

  test("does not retry or request a wallet when silent reauthentication is unavailable", async () => {
    let retries = 0;
    let walletRequests = 0;

    const result = await recoverMissingParentDelegation({
      initialError: new Error("Cannot find parent delegation"),
      clearSession: async () => undefined,
      reauthenticateSilently: async () => false,
      retry: async () => {
        retries += 1;
        walletRequests += 1;
        return "unexpected";
      },
      onOutcome: () => undefined,
    });

    expect(result.status).toBe("reconnect_required");
    expect(retries).toBe(0);
    expect(walletRequests).toBe(0);
  });

  test("in-app mint uses shared teardown, retries once, and emits healed", async () => {
    let delegationAttempts = 0;
    let signOuts = 0;
    let freshBootstraps = 0;
    let submissions = 0;
    const events: Array<Record<string, unknown>> = [];
    const deadSession = inputAuthoritySession({
      delegate: async () => {
        delegationAttempts += 1;
        throw new Error("Failed to activate delegation with host: Cannot find parent delegation");
      },
      signOut: async () => {
        signOuts += 1;
        throw new Error("stale session teardown failed");
      },
    });
    const freshSession = inputAuthoritySession({
      delegate: async () => {
        delegationAttempts += 1;
        return childDelegation();
      },
      signIn: async () => { freshBootstraps += 1; },
    });
    const client = {
      attachInputAuthority: async () => {
        submissions += 1;
        return { attached: true };
      },
    } as unknown as FeedV1HostClient;
    const restore = overrideFeedAuthForTest({
      instance: deadSession,
      activeWallet: wallet(async () => true),
      activeSessionMode: "restored",
      createTinyCloudWeb: () => freshSession,
      reportRecoveryClientEvent: (level, event, detail, actorId, fields) => {
        events.push({ level, event, detail, actorId, ...fields });
      },
    });

    try {
      await attachReceivedInputAuthority(authorityInput(client));
    } finally {
      restore();
    }

    expect({ delegationAttempts, signOuts, freshBootstraps, submissions }).toEqual({
      delegationAttempts: 2,
      signOuts: 1,
      freshBootstraps: 1,
      submissions: 1,
    });
    expect(events).toEqual([{
      level: "info",
      event: "missing_parent_recovery",
      detail: undefined,
      actorId: "did:key:zReader",
      session_mode: "restored",
      stage: "activate",
      outcome: "healed",
    }]);
  });

  test("in-app mint stops after a second missing parent and requires reconnect", async () => {
    let delegationAttempts = 0;
    let signOuts = 0;
    const outcomes: unknown[] = [];
    const missingParent = async () => {
      delegationAttempts += 1;
      throw new Error("Cannot find parent delegation");
    };
    const deadSession = inputAuthoritySession({
      delegate: missingParent,
      signOut: async () => { signOuts += 1; },
    });
    const retriedSession = inputAuthoritySession({
      delegate: missingParent,
      signOut: async () => { signOuts += 1; },
    });
    const client = {
      attachInputAuthority: async () => ({ attached: true }),
    } as unknown as FeedV1HostClient;
    const restore = overrideFeedAuthForTest({
      instance: deadSession,
      activeWallet: wallet(async () => true),
      activeSessionMode: "restored",
      createTinyCloudWeb: () => retriedSession,
      reportRecoveryClientEvent: (_level, _event, _detail, _actorId, fields) => {
        outcomes.push(fields.outcome);
      },
    });

    try {
      await expect(attachReceivedInputAuthority(authorityInput(client))).rejects.toBeInstanceOf(
        FeedReconnectRequiredError,
      );
    } finally {
      restore();
    }

    expect(delegationAttempts).toBe(2);
    expect(signOuts).toBe(2);
    expect(outcomes).toEqual(["reconnect_required"]);
  });

  test("in-app mint does not bootstrap or retry when silent signing is unavailable", async () => {
    let walletChecks = 0;
    let factoryCalls = 0;
    let delegationAttempts = 0;
    const deadSession = inputAuthoritySession({
      delegate: async () => {
        delegationAttempts += 1;
        throw new Error("Cannot find parent delegation");
      },
    });
    const client = {
      attachInputAuthority: async () => ({ attached: true }),
    } as unknown as FeedV1HostClient;
    const restore = overrideFeedAuthForTest({
      instance: deadSession,
      activeWallet: wallet(async () => {
        walletChecks += 1;
        return false;
      }),
      activeSessionMode: "restored",
      createTinyCloudWeb: () => {
        factoryCalls += 1;
        return deadSession;
      },
      reportRecoveryClientEvent: () => undefined,
    });

    try {
      await expect(attachReceivedInputAuthority(authorityInput(client))).rejects.toBeInstanceOf(
        FeedReconnectRequiredError,
      );
    } finally {
      restore();
    }

    expect(walletChecks).toBe(1);
    expect(factoryCalls).toBe(0);
    expect(delegationAttempts).toBe(1);
  });
});
