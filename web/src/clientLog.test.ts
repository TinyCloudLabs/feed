import { afterEach, describe, expect, test } from "bun:test";
import { reportStartupTiming } from "./clientLog.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("startup timing reporting", () => {
  test("sends only the structured timing event with its correlation header", async () => {
    const calls: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ accepted: 1 }), { status: 200 });
    }) as typeof fetch;

    reportStartupTiming({
      traceId: "feed_trace_test",
      flow: "interactive_sign_in",
      stage: "tinycloud_sign_in",
      phase: "end",
      clientTs: "2026-07-11T12:00:00.000Z",
      elapsedMs: 125,
      durationMs: 80,
      outcome: "ok",
    });
    await Promise.resolve();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get("x-feed-trace-id")).toBe("feed_trace_test");
    expect(calls[0]!.headers.get("x-feed-actor-id")).toBeNull();
    expect(calls[0]!.body).toEqual({
      level: "info",
      event: "startup_timing",
      traceId: "feed_trace_test",
      flow: "interactive_sign_in",
      stage: "tinycloud_sign_in",
      phase: "end",
      clientTs: "2026-07-11T12:00:00.000Z",
      elapsedMs: 125,
      durationMs: 80,
      outcome: "ok",
    });
  });
});
