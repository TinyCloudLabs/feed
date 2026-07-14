import { describe, expect, test } from "bun:test";
import {
  FEED_MANIFEST,
  FeedReconnectRequiredError,
  isFeedReconnectRequiredError,
} from "./authPolicy.ts";
import { isRetryableDelegationConflict, isRetryableSpaceCreationFailure } from "./delegationRetry.ts";

describe("Feed sign-in policy", () => {
  test("retries only TinyCloud delegation serialization conflicts", () => {
    expect(isRetryableDelegationConflict(new Error("epoch insert failed: could not serialize access"))).toBe(true);
    expect(isRetryableDelegationConflict(new Error("Unauthorized Action"))).toBe(false);
    expect(isRetryableDelegationConflict(new Error("Failed to fetch"))).toBe(false);
  });

  test("retries only the idempotent first-use space creation failure", () => {
    expect(isRetryableSpaceCreationFailure(new Error("Failed to create space: did:pkh:example:applications"))).toBe(true);
    expect(isRetryableSpaceCreationFailure(new Error("User rejected wallet request"))).toBe(false);
  });
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
