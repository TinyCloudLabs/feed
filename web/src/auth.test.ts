import { describe, expect, test } from "bun:test";
import {
  FEED_MANIFEST,
  FeedReconnectRequiredError,
  isFeedReconnectRequiredError,
} from "./authPolicy.ts";

describe("Feed sign-in policy", () => {
  test("does not request a separate first-run approval store", () => {
    expect(FEED_MANIFEST.permissions).toEqual([]);
    expect(JSON.stringify(FEED_MANIFEST)).not.toContain("first-run-approval");
  });

  test("uses a typed, user-readable reconnect error without authority details", () => {
    const error = new FeedReconnectRequiredError(new Error("tinycloud.kv/put denied"));
    expect(isFeedReconnectRequiredError(error)).toBe(true);
    expect(error.message).toBe("Your saved Feed access needs to be refreshed. Sign in again to continue.");
    expect(error.message).not.toContain("tinycloud");
  });
});
