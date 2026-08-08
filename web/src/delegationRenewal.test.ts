import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FeedReconnectRequiredError } from "./authPolicy.ts";
import type { FeedHostDelegationReceipt } from "./delegation.ts";
import type { FeedV1HostClient } from "./feedV1HostClient.ts";
import {
  DELEGATION_RENEWAL_MIN_INTERVAL_MS,
  isDelegationRenewalDue,
  noteDelegationSubmitted,
  noteSessionRestored,
  renewDelegation,
  resetDelegationRenewalState,
} from "./delegationRenewal.ts";

const ACTOR = "did:key:zReader";

function receipt(): FeedHostDelegationReceipt {
  return {
    accepted: true,
    actorId: ACTOR,
    resources: [],
    status: "active",
    setup: {
      state: "ready",
      phase: "ready",
      attempt: 1,
      startedAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:01.000Z",
    },
  };
}

// The renewal reuses auth.ts's submission path, which ends in this one host
// call. Mocking the client keeps the SDK (and any wallet surface) out of the
// unit test while still exercising submission, telemetry, and classification.
function mockClient(behavior: () => Promise<FeedHostDelegationReceipt> = async () => receipt()) {
  const submissions: Array<{ actorId: string; serializedDelegation: string }> = [];
  const client = {
    submitDelegation: async (submission: { actorId: string; serializedDelegation: string }) => {
      submissions.push(submission);
      return behavior();
    },
  } as unknown as FeedV1HostClient;
  const submit = async (): Promise<FeedHostDelegationReceipt[]> => [
    await client.submitDelegation({ actorId: ACTOR, serializedDelegation: "delegation-blob" }),
  ];
  return { client, submissions, submit };
}

let events: Array<Record<string, unknown>>;
let previousFetch: typeof fetch;

beforeEach(() => {
  resetDelegationRenewalState();
  events = [];
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") events.push(JSON.parse(init.body) as Record<string, unknown>);
    return new Response(undefined, { status: 204 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  resetDelegationRenewalState();
});

describe("rolling delegation renewal", () => {
  test("re-mints and resubmits for a restored session", async () => {
    const { submissions, submit } = mockClient();

    const outcome = await renewDelegation({ actorId: ACTOR, submit });

    expect(outcome).toBe("renewed");
    expect(submissions).toEqual([{ actorId: ACTOR, serializedDelegation: "delegation-blob" }]);
    expect(events.find((event) => event.event === "delegation_renewed")).toMatchObject({
      level: "info",
      event: "delegation_renewed",
      detail: "setup=ready",
      session_mode: "restored",
    });
  });

  test("is idempotent within the renewal interval and across concurrent callers", async () => {
    const { submissions, submit } = mockClient();

    const [first, second] = await Promise.all([
      renewDelegation({ actorId: ACTOR, submit }),
      renewDelegation({ actorId: ACTOR, submit }),
    ]);
    const third = await renewDelegation({ actorId: ACTOR, submit });

    expect(first).toBe("renewed");
    expect(second).toBe("renewed");
    expect(third).toBe("skipped");
    expect(submissions).toHaveLength(1);
  });

  test("a sign-in submission already starts the window", async () => {
    const { submissions, submit } = mockClient();
    noteDelegationSubmitted(ACTOR);

    expect(await renewDelegation({ actorId: ACTOR, submit })).toBe("skipped");
    expect(submissions).toHaveLength(0);
  });

  test("the next app open renews again", async () => {
    const { submissions, submit } = mockClient();
    await renewDelegation({ actorId: ACTOR, submit });

    noteSessionRestored();

    expect(await renewDelegation({ actorId: ACTOR, submit })).toBe("renewed");
    expect(submissions).toHaveLength(2);
  });

  test("a stale window and a different actor are both due again", () => {
    noteDelegationSubmitted(ACTOR, 1_000);

    expect(isDelegationRenewalDue(ACTOR, 1_000 + DELEGATION_RENEWAL_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(isDelegationRenewalDue(ACTOR, 1_000 + DELEGATION_RENEWAL_MIN_INTERVAL_MS)).toBe(true);
    expect(isDelegationRenewalDue("did:key:zOther", 1_000)).toBe(true);
  });

  test("an ordinary failure is reported without disturbing the running feed", async () => {
    const { submit } = mockClient(async () => { throw new Error("Failed to fetch"); });

    const outcome = await renewDelegation({ actorId: ACTOR, submit });

    expect(outcome).toBe("failed");
    expect(events.find((event) => event.event === "delegation_renewal_failed")).toMatchObject({
      level: "warn",
      session_mode: "restored",
    });
    // The window never opened, so the next app open retries.
    expect(isDelegationRenewalDue(ACTOR)).toBe(true);
  });

  test("a session-scope failure surfaces for the existing reconnect handling", async () => {
    const { submit } = mockClient(async () => {
      throw new FeedReconnectRequiredError(new Error("SessionExpiredError"));
    });

    await expect(renewDelegation({ actorId: ACTOR, submit })).rejects.toBeInstanceOf(FeedReconnectRequiredError);
    expect(events.find((event) => event.event === "delegation_renewal_failed")).toBeDefined();
  });

  test("telemetry carries no delegation material", async () => {
    const { submit } = mockClient();
    await renewDelegation({
      actorId: ACTOR,
      submit,
      trace: { traceId: "trace-1", loginStartedAt: performance.now(), sessionMode: "restored" },
    });

    const renewed = events.find((event) => event.event === "delegation_renewed");
    expect(JSON.stringify(renewed)).not.toContain("delegation-blob");
  });
});
