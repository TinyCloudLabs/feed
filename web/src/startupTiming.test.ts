import { describe, expect, test } from "bun:test";
import { StartupTrace, type StartupTimingEvent } from "./startupTiming.ts";

describe("StartupTrace", () => {
  test("emits correlated stage and total durations", async () => {
    let now = 100;
    const events: StartupTimingEvent[] = [];
    const trace = new StartupTrace(
      "interactive_sign_in",
      (event) => events.push(event),
      {
        now: () => now,
        timestamp: () => "2026-07-11T12:00:00.000Z",
        id: () => "feed_trace_test",
      },
    );

    trace.mark("user_started");
    await trace.measure("policy_fetch", async () => {
      now = 145;
    });
    trace.start("tinycloud_sign_in");
    now = 250;
    trace.end("tinycloud_sign_in");
    now = 280;
    trace.complete("ok");

    expect(events).toEqual([
      expect.objectContaining({ traceId: "feed_trace_test", stage: "user_started", phase: "mark", elapsedMs: 0 }),
      expect.objectContaining({ stage: "policy_fetch", phase: "start", elapsedMs: 0 }),
      expect.objectContaining({ stage: "policy_fetch", phase: "end", elapsedMs: 45, durationMs: 45, outcome: "ok" }),
      expect.objectContaining({ stage: "tinycloud_sign_in", phase: "start", elapsedMs: 45 }),
      expect.objectContaining({ stage: "tinycloud_sign_in", phase: "end", elapsedMs: 150, durationMs: 105 }),
      expect.objectContaining({ stage: "startup_total", phase: "complete", elapsedMs: 180, durationMs: 180, outcome: "ok" }),
    ]);
  });

  test("records failed stages and ignores events after completion", async () => {
    let now = 0;
    const events: StartupTimingEvent[] = [];
    const trace = new StartupTrace(
      "session_restore",
      (event) => events.push(event),
      { now: () => now, timestamp: () => "2026-07-11T12:00:00.000Z", id: () => "feed_failed" },
    );

    await expect(trace.measure("session_restore", async () => {
      now = 12;
      throw new Error("private material must not be logged");
    })).rejects.toThrow();
    trace.complete("error");
    trace.mark("too_late");

    expect(events.map(({ stage, phase, outcome }) => ({ stage, phase, outcome }))).toEqual([
      { stage: "session_restore", phase: "start", outcome: undefined },
      { stage: "session_restore", phase: "end", outcome: "error" },
      { stage: "startup_total", phase: "complete", outcome: "error" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private material");
  });
});
