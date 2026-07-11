// Fire-and-forget error/event reporting to the Feed Host's structured log
// stream (/api/client-events). Browser failures — sign-in, delegation minting,
// feed setup — were previously invisible outside the devtools console; this
// makes them show up next to the host's own request logs.

import { FEED_HOST_URL } from "./config.ts";

export type ClientLogLevel = "info" | "warn" | "error";

export function reportClientEvent(level: ClientLogLevel, event: string, detail?: string, actorId?: string): void {
  try {
    void fetch(`${FEED_HOST_URL.replace(/\/+$/, "")}/api/client-events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(actorId ? { "x-feed-actor-id": actorId } : {}),
      },
      body: JSON.stringify({ level, event, detail: detail?.slice(0, 500) }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Reporting must never break the app.
  }
}

export function errorDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function installGlobalErrorReporting(): void {
  window.addEventListener("error", (event) => {
    reportClientEvent("error", "window_error", event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportClientEvent("error", "unhandled_rejection", errorDetail(event.reason));
  });
}
