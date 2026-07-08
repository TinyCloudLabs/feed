import { describe, expect, test } from "bun:test";
import { DEFAULT_REVIEWED_BUNDLE } from "../../shared/default-reviewed-bundle.ts";
import { firstRunApprovalKey } from "./firstRunConsent.ts";

describe("first-run approval persistence", () => {
  test("scopes approval storage to host origin and bundle digest", () => {
    const hostOrigin = "https://api.feed.tinycloud.xyz";
    const key = firstRunApprovalKey(hostOrigin);
    const otherKey = firstRunApprovalKey("https://other.feed.tinycloud.xyz");

    expect(key).toContain(encodeURIComponent(DEFAULT_REVIEWED_BUNDLE.packageId));
    expect(key).toContain(encodeURIComponent(hostOrigin));
    expect(key).toContain(encodeURIComponent(DEFAULT_REVIEWED_BUNDLE.digest));
    expect(otherKey).not.toBe(key);
  });
});
