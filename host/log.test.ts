import { expect, spyOn, test } from "bun:test";
import {
  HOST_EVENT_BUFFER_LIMIT,
  logEvent,
  recentHostEvents,
  resetHostEventBufferForTests,
} from "./log.ts";

test("structured logs redact raw shares, private keys, parent bearers, and child delegations", () => {
  const previous = process.env.FEED_HOST_LOG;
  process.env.FEED_HOST_LOG = "1";
  const output: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
  try {
    const jwtFixture = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJkZWxlZ2F0aW9uIn0", "c2lnbmF0dXJl"].join(".");
    logEvent("info", "input_authority_rejected", {
      tc1Link: "tc1:raw-secret",
      clientPrivateJwk: { d: "private-material" },
      parentBearer: "Bearer parent-secret",
      portableDelegation: "child-secret",
      detail: "SDK failed for tc1:raw-secret",
      jwtError: `SDK rejected ${jwtFixture}`,
      keyError: "SDK received 0x1111111111111111111111111111111111111111111111111111111111111111",
      safe: "team-listen",
    });
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("team-listen");
    for (const secret of ["raw-secret", "private-material", "parent-secret", "child-secret", "eyJhbGci", "1111111111"]) {
      expect(output[0]).not.toContain(secret);
    }
  } finally {
    log.mockRestore();
    process.env.FEED_HOST_LOG = previous;
  }
});

test("host event buffer caps at 200, accepts concurrent writers, and exposes hashed ids without payloads", async () => {
  const previous = process.env.FEED_HOST_LOG;
  process.env.FEED_HOST_LOG = "0";
  resetHostEventBufferForTests();
  try {
    await Promise.all(Array.from({ length: 250 }, async (_, index) => {
      logEvent("info", `event-${index}`, {
        actorId: "did:example:private-actor",
        requestId: `request-${index}`,
        prompt: `private prompt ${index}`,
        detail: `private detail ${index}`,
        path: `/api/worker/generation-requests/request-${index}/phase`,
        phase: "running",
      });
    }));
    const events = recentHostEvents();
    expect(events).toHaveLength(HOST_EVENT_BUFFER_LIMIT);
    expect(events[0]?.event).toBe("event-50");
    expect(events.at(-1)?.event).toBe("event-249");
    expect(events[0]).toMatchObject({ phase: "running" });
    const encoded = JSON.stringify(events);
    expect(encoded).not.toContain("did:example:private-actor");
    expect(encoded).not.toContain("request-50");
    expect(encoded).not.toContain("private prompt");
    expect(encoded).not.toContain("private detail");
    expect(events[0]?.actorHash).toMatch(/^[a-f0-9]{12}$/);
    expect(events[0]?.requestHash).toMatch(/^[a-f0-9]{12}$/);
    expect(events[0]?.path).toMatch(/^\/api\/worker\/generation-requests\/\[HASH:[a-f0-9]{12}\]\/phase$/);
  } finally {
    resetHostEventBufferForTests();
    process.env.FEED_HOST_LOG = previous;
  }
});
