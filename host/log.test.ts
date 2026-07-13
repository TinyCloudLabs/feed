import { expect, spyOn, test } from "bun:test";
import { logEvent } from "./log.ts";

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
