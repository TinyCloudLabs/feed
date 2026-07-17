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

export const MISSING_PARENT_RECONNECT_MESSAGE = "The storage service was updated. Sign in once to reconnect.";

export class FeedReconnectRequiredError extends Error {
  constructor(
    cause?: unknown,
    message = "Your saved Feed access needs to be refreshed. Sign in again to continue.",
  ) {
    super(message, { cause });
    this.name = "FeedReconnectRequiredError";
  }
}

export function isFeedReconnectRequiredError(error: unknown): error is FeedReconnectRequiredError {
  return error instanceof FeedReconnectRequiredError;
}
