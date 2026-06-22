import { describe, expect, test } from "bun:test";
import { formatRunAge, runLogTail } from "./runTelemetry.ts";

describe("run telemetry", () => {
  test("keeps a bounded recent log tail", () => {
    expect(runLogTail(["a", "b", "c"], 2)).toEqual(["b", "c"]);
    expect(runLogTail(["a", "b"], 6)).toEqual(["a", "b"]);
    expect(runLogTail(undefined)).toEqual([]);
  });

  test("formats run age from a backend timestamp", () => {
    const now = Date.UTC(2026, 5, 22, 12, 0, 0);
    expect(formatRunAge(now - 12_000, now)).toBe("less than 1 min");
    expect(formatRunAge(now - 18 * 60_000, now)).toBe("18 min");
    expect(formatRunAge(now - 2 * 60 * 60_000, now)).toBe("2 hr");
    expect(formatRunAge(now - (2 * 60 + 7) * 60_000, now)).toBe("2 hr 7 min");
  });

  test("ignores missing or invalid start times", () => {
    expect(formatRunAge(undefined)).toBeNull();
    expect(formatRunAge(Number.NaN)).toBeNull();
  });
});
