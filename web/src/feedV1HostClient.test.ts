import { describe, expect, test } from "bun:test";
import { FeedV1HostClient, FeedV1HostError } from "./feedV1HostClient.ts";
import type {
  ControlIntentEvent,
  FeedbackEvent,
} from "../../../artifactory/skills/_shared/lib/feed-v1.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("FeedV1HostClient", () => {
  test("lists Feed projections through the separate host API", async () => {
    const calls: string[] = [];
    const client = new FeedV1HostClient({
      baseUrl: "https://feed.example.test/",
      token: "token-1",
      actorId: "did:pkh:eip155:1:0xabc",
      fetchImpl: async (input, init) => {
        calls.push(String(input));
        expect((init?.headers as Headers).get("authorization")).toBe("Bearer token-1");
        expect((init?.headers as Headers).get("x-feed-actor-id")).toBe("did:pkh:eip155:1:0xabc");
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
    const feedback: FeedbackEvent = {
      eventId: "event-1",
      artifactId: "artifact-1",
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

  test("fetches delegation policy and submits portable delegation", async () => {
    const calls: { url: string; body?: unknown }[] = [];
    const client = new FeedV1HostClient({
      baseUrl: "https://feed.example.test",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (String(input).endsWith("/delegation-policy")) {
          return jsonResponse({ delegateDID: "did:key:feed-host", resources: [] });
        }
        return jsonResponse({ accepted: true, actorId: "did:pkh:reader", resources: ["feed_index"] });
      },
    });

    const policy = await client.getDelegationPolicy();
    const receipt = await client.submitDelegation({
      actorId: "did:pkh:reader",
      serializedDelegation: "{\"delegateDID\":\"did:key:feed-host\"}",
    });

    expect(policy.delegateDID).toBe("did:key:feed-host");
    expect(receipt.accepted).toBe(true);
    expect(calls).toEqual([
      { url: "https://feed.example.test/delegation-policy", body: undefined },
      {
        url: "https://feed.example.test/delegations",
        body: { actorId: "did:pkh:reader", serializedDelegation: "{\"delegateDID\":\"did:key:feed-host\"}" },
      },
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
