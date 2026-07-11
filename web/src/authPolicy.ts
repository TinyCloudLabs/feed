import type { Manifest } from "@tinycloud/web-sdk";

export const FEED_MANIFEST: Manifest = {
  manifest_version: 1,
  app_id: "xyz.tinycloud.feed",
  name: "TinyFeed",
  description: "Private Feed Host client for Feed v1 artifacts and controls.",
  space: "applications",
  prefix: "",
  defaults: false,
  permissions: [],
};

export class FeedReconnectRequiredError extends Error {
  constructor(cause?: unknown) {
    super("Your saved Feed access needs to be refreshed. Sign in again to continue.", { cause });
    this.name = "FeedReconnectRequiredError";
  }
}

export function isFeedReconnectRequiredError(error: unknown): error is FeedReconnectRequiredError {
  return error instanceof FeedReconnectRequiredError;
}
