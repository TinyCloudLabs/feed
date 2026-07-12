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
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...sanitizeLogFields(fields) });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

const SENSITIVE_LOG_KEY = /(tc1|private.?jwk|private.?key|parent.?bearer|authorization|secret|portable.?delegation)/i;
const SENSITIVE_LOG_VALUE = /(?:tc1:|Bearer\s+)[^\s"']+/i;

function sanitizeLogFields(fields: FeedHostLogFields): FeedHostLogFields {
  const seen = new WeakSet<object>();
  const sanitize = (value: unknown, key?: string): unknown => {
    if (key && SENSITIVE_LOG_KEY.test(key)) return "[REDACTED]";
    if (typeof value === "string") return SENSITIVE_LOG_VALUE.test(value) ? "[REDACTED]" : value;
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[REDACTED]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [entryKey, sanitize(entry, entryKey)]));
  };
  return sanitize(fields) as FeedHostLogFields;
}

export function levelForStatus(status: number): FeedHostLogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}
