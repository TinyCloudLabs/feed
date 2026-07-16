import { describe, expect, test } from "bun:test";
import { buildClientEventPayload } from "./clientLog.ts";

describe("client event payloads", () => {
  test.each(["fresh", "restored"] as const)("includes session_mode=%s on login events", (sessionMode) => {
    expect(buildClientEventPayload("info", "login_tinycloud_signed_in", undefined, {
      traceId: "trace-login",
      session_mode: sessionMode,
    })).toMatchObject({
      event: "login_tinycloud_signed_in",
      session_mode: sessionMode,
    });
  });

  test("keeps delegation failure stage typed and truncates existing detail", () => {
    const payload = buildClientEventPayload("error", "delegation_mint_failed", "x".repeat(600), {
      session_mode: "restored",
      stage: "activate",
    });
    expect(payload).toMatchObject({ session_mode: "restored", stage: "activate" });
    expect(String(payload.detail)).toHaveLength(500);
  });
});
