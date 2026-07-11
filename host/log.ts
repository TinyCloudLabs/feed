// Structured JSON logging for the Feed Host. One line per event so local runs
// and log collectors can both consume the stream. Disable with FEED_HOST_LOG=0
// (tests set this to keep output quiet).

export type FeedHostLogLevel = "debug" | "info" | "warn" | "error";

export type FeedHostLogFields = Record<string, unknown>;

function loggingEnabled(): boolean {
  return process.env.FEED_HOST_LOG !== "0";
}

export function logEvent(level: FeedHostLogLevel, event: string, fields: FeedHostLogFields = {}): void {
  if (!loggingEnabled()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function levelForStatus(status: number): FeedHostLogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}
