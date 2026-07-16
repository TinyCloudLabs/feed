import { describe, expect, test } from "bun:test";
import { FeedV1HostClient, FeedV1HostError } from "./feedV1HostClient.ts";
import type {
  ControlIntentEvent,
} from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import type { FeedTargetedInteractionEvent } from "../../shared/feed-item.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("FeedV1HostClient", () => {
  test("builds the credentialed same-origin hero endpoint URL", () => {
    const client = new FeedV1HostClient({ baseUrl: "https://feed.example.test/" });
    expect(client.heroUrl("artifact/one")).toBe("https://feed.example.test/artifacts/artifact%2Fone/hero");
  });

  test("lists Feed projections through the separate host API", async () => {
    const calls: string[] = [];
    const client = new FeedV1HostClient({
      baseUrl: "https://feed.example.test/",
      token: "token-1",
      actorId: "did:pkh:eip155:1:0xabc",
      traceId: "trace-login-1",
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        expect((init?.headers as Headers).get("authorization")).toBe("Bearer token-1");
        expect((init?.headers as Headers).get("x-feed-actor-id")).toBe("did:pkh:eip155:1:0xabc");
        expect((init?.headers as Headers).get("x-feed-trace-id")).toBe("trace-login-1");
        return jsonResponse({ items: [], nextCursor: "next" });
      },
    });

    const page = await client.listFeed({ limit: 25, cursor: "abc" });
    expect(page.nextCursor).toBe("next");
    expect(calls).toEqual(["https://feed.example.test/feed?limit=25&cursor=abc"]);
  });

  test("posts feedback and control intents as JSON", async () => {
    const bodies: unknown[] = [];
    const client = new FeedV1HostClient({
      baseUrl: "https://feed.example.test",
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        expect((init?.headers as Headers).get("content-type")).toBe("application/json");
        return jsonResponse({ accepted: true, eventId: "event-1" });
      },
    });
    const feedback: FeedTargetedInteractionEvent = {
      eventId: "event-1",
      target: { kind: "feed_item", feedItemId: "artifact-1::post-1" },
      actorId: "did:key:reader",
      readerNonce: "nonce-1",
      signal: "helpful",
      createdAt: "2026-06-28T12:00:00.000Z",
    };
    const intent: ControlIntentEvent = {
      eventId: "event-2",
      actorId: "did:key:reader",
      readerNonce: "nonce-2",
      intentKind: "ask_feed",
      status: "accepted",
      targetRef: "feed",
      createdAt: "2026-06-28T12:00:00.000Z",
    };

    await client.postFeedback(feedback);
    await client.postControlIntent(intent);

    expect(bodies).toEqual([feedback, intent]);
  });

  test("polls the feed-events SSE snapshot with actor headers", async () => {
    const calls: string[] = [];
    const client = new FeedV1HostClient({
      baseUrl: "https://feed.example.test",
      actorId: "did:pkh:eip155:1:0xabc",
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        expect((init?.headers as Headers).get("accept")).toBe("text/event-stream");
        expect((init?.headers as Headers).get("x-feed-actor-id")).toBe("did:pkh:eip155:1:0xabc");
        return new Response("retry: 5000\n\nid: projection:one:2026-06-29T12:00:00.000Z\nevent: projection-updated\ndata: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const snapshot = await client.getFeedEvents();
    expect(snapshot.text).toContain("projection-updated");
    expect(calls).toEqual(["https://feed.example.test/feed/events"]);
  });

  test("fetches delegation policy, submits portable delegation, and disconnects", async () => {
    const calls: { url: string; body?: unknown; credentials?: RequestCredentials }[] = [];
    const client = new FeedV1HostClient({
      baseUrl: "https://feed.example.test",
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          credentials: init?.credentials,
        });
        if (String(input).endsWith("/delegation-policy")) {
          return jsonResponse({ delegateDID: "did:key:feed-host", resources: [] });
        }
        return jsonResponse({
          accepted: true,
          actorId: "did:pkh:reader",
          resources: ["feed_index"],
        });
      },
    });

    const policy = await client.getDelegationPolicy();
    const receipt = await client.submitDelegation({
      actorId: "did:pkh:reader",
      serializedDelegation: "{\"delegateDID\":\"did:key:feed-host\"}",
    });
    await client.disconnectFeed();

    expect(policy.delegateDID).toBe("did:key:feed-host");
    expect(receipt.accepted).toBe(true);
    expect(calls).toEqual([
      { url: "https://feed.example.test/delegation-policy", body: undefined, credentials: "include" },
      {
        url: "https://feed.example.test/api/delegations",
        body: { actorId: "did:pkh:reader", serializedDelegation: "{\"delegateDID\":\"did:key:feed-host\"}" },
        credentials: "include",
      },
      { url: "https://feed.example.test/api/delegations", body: undefined, credentials: "include" },
    ]);
  });

  test("reads backend setup state and requests a preparation retry", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const setup = {
      state: "failed" as const,
      phase: "failed" as const,
      attempt: 1,
      startedAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:00:10.000Z",
      error: { code: "preparation_failed" as const, message: "bootstrap failed" },
    };
    const client = new FeedV1HostClient({
      baseUrl: "https://feed.example.test",
      actorId: "did:pkh:reader",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        if (String(input).endsWith("/status")) {
          return jsonResponse({
            actorId: "did:pkh:reader",
            delegateDID: "did:key:host",
            policyHash: "sha256:one",
            currentPolicyHash: "sha256:one",
            state: "active",
            complete: true,
            resources: [],
            setup,
          });
        }
        return jsonResponse({ accepted: true, actorId: "did:pkh:reader", setup: { ...setup, state: "preparing" } }, { status: 202 });
      },
    });

    expect((await client.getDelegationStatus()).setup?.state).toBe("failed");
    expect((await client.retrySetup()).setup.state).toBe("preparing");
    expect(calls).toEqual([
      { url: "https://feed.example.test/api/delegations/status", method: undefined },
      { url: "https://feed.example.test/api/delegations/retry", method: "POST" },
    ]);
  });

  test("lists skills and patches skill credentials against actor-scoped host routes", async () => {
    const PLANTED = "PLANTED_SECRET_client_e2f";
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const client = new FeedV1HostClient({
      baseUrl: "https://feed.example.test",
      token: "token-1",
      actorId: "did:pkh:eip155:1:0xabc",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push({
          url,
          method,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        expect((init?.headers as Headers).get("x-feed-actor-id")).toBe("did:pkh:eip155:1:0xabc");
        if (url.endsWith("/skills")) {
          return jsonResponse({
            items: [
              {
                skillId: "shared-skill",
                credentialMode: "user_byok_api_key",
                providerId: "openai",
                hasSecret: true,
                budget: { budgetId: "shared-skill", spent: 0, currency: "USD", disabled: false, status: "ready" },
                version: 1,
                updatedAt: "2026-07-08T00:00:00.000Z",
              },
            ],
          });
        }
        return jsonResponse({
          updated: true,
          skill: {
            skillId: "shared-skill",
            credentialMode: "user_byok_api_key",
            providerId: "openai",
            hasSecret: true,
            budget: { budgetId: "shared-skill", spent: 0, currency: "USD", disabled: false, status: "ready" },
            version: 2,
            updatedAt: "2026-07-08T00:00:01.000Z",
          },
        });
      },
    });

    const page = await client.listSkills();
    expect(page.items).toHaveLength(1);
    expect(page.items[0].hasSecret).toBe(true);
    // The wire type has no secretRef field to prevent a submitted secret from
    // leaking back through the client.
    expect("secretRef" in page.items[0]).toBe(false);

    const patched = await client.patchSkillCredentials("shared-skill", {
      expectedVersion: 1,
      credentialMode: "user_byok_api_key",
      providerId: "openai",
      secretRef: PLANTED,
    });
    expect(patched.skill.hasSecret).toBe(true);
    expect("secretRef" in patched.skill).toBe(false);
    // The client submits the secret on the way up but the returned skill
    // object never re-exposes it.
    expect(JSON.stringify(patched).includes(PLANTED)).toBe(false);
    expect(calls[1].url).toBe("https://feed.example.test/skills/shared-skill/credentials");
    expect(calls[1].method).toBe("PATCH");
    expect(calls[1].body).toEqual({
      expectedVersion: 1,
      credentialMode: "user_byok_api_key",
      providerId: "openai",
      secretRef: PLANTED,
    });
  });

  test("manages named input authorities without sending a raw share", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = new FeedV1HostClient({
      baseUrl: "https://feed.example.test",
      actorId: "did:pkh:reader",
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return jsonResponse({ items: [], attached: true, revoked: true, item: { sourceId: "team", state: "active" } });
      },
    });
    await client.listInputAuthorities();
    await client.attachInputAuthority({ sourceId: "team", displayName: "Team", portableDelegation: "child-only" });
    await client.inspectInputAuthority("team");
    await client.inputAuthorityStatus("team");
    await client.revokeInputAuthority("team");
    await client.removeInputAuthority("team");

    expect(JSON.stringify(calls)).not.toContain("tc1:");
    expect(calls.map(({ url, method }) => [url, method])).toEqual([
      ["https://feed.example.test/input-authorities", "GET"],
      ["https://feed.example.test/input-authorities", "POST"],
      ["https://feed.example.test/input-authorities/team", "GET"],
      ["https://feed.example.test/input-authorities/team/status", "GET"],
      ["https://feed.example.test/input-authorities/team/revoke", "POST"],
      ["https://feed.example.test/input-authorities/team", "DELETE"],
    ]);
  });

  test("surfaces non-2xx host responses", async () => {
    const client = new FeedV1HostClient({
      baseUrl: "https://feed.example.test",
      fetchImpl: async () => new Response("blocked", { status: 403 }),
    });

    await expect(client.getArtifact("a/1")).rejects.toBeInstanceOf(FeedV1HostError);
  });
});
