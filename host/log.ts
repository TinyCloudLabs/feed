// Structured JSON logging for the Feed Host. One line per event so local runs
// and log collectors can both consume the stream. Disable with FEED_HOST_LOG=0
// (tests set this to keep output quiet).

import { createHash } from "node:crypto";

export type FeedHostLogLevel = "debug" | "info" | "warn" | "error";

export type FeedHostLogFields = Record<string, unknown>;

export type FeedHostLogEvent = FeedHostLogFields & {
  ts: string;
  level: FeedHostLogLevel;
  event: string;
};

export const HOST_EVENT_BUFFER_LIMIT = 200;
const hostEventBuffer: FeedHostLogEvent[] = [];

function loggingEnabled(): boolean {
  return process.env.FEED_HOST_LOG !== "0";
}

export function logEvent(level: FeedHostLogLevel, event: string, fields: FeedHostLogFields = {}): void {
  const ts = new Date().toISOString();
  const sanitized = sanitizeLogFields(fields);
  hostEventBuffer.push({ ts, level, event, ...ringSafeFields(sanitized) });
  if (hostEventBuffer.length > HOST_EVENT_BUFFER_LIMIT) {
    hostEventBuffer.splice(0, hostEventBuffer.length - HOST_EVENT_BUFFER_LIMIT);
  }
  if (!loggingEnabled()) return;
  const line = JSON.stringify({ ts, level, event, ...sanitized });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function recentHostEvents(): FeedHostLogEvent[] {
  return hostEventBuffer.map((entry) => structuredClone(entry));
}

/** Test-only reset; production never clears the in-memory diagnostic window. */
export function resetHostEventBufferForTests(): void {
  hostEventBuffer.length = 0;
}

const SENSITIVE_LOG_KEY = /(tc1|private.?jwk|private.?key|parent.?bearer|authorization|secret|portable.?delegation)/i;
const SENSITIVE_LOG_VALUE = /(?:tc1:|Bearer\s+)[^\s"']+|\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b|\b(?:0x)?[0-9a-f]{64}\b/i;

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

const RING_PAYLOAD_KEY = /(?:payload|prompt|transcript|artifact.?body|content|detail|error.?message|note)/i;
const RING_ID_KEY = /(?:actor|artifact|request|run|workflow|package|manifest|source|trace|event)Id$/i;

function ringSafeFields(fields: FeedHostLogFields): FeedHostLogFields {
  const safe: FeedHostLogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (RING_PAYLOAD_KEY.test(key)) continue;
    if (key === "path" && typeof value === "string") {
      safe.path = ringSafeRoutePath(value);
    } else if (/Hash(?:es)?$/i.test(key)) {
      safe[key] = ringSafeValue(value);
    } else if (RING_ID_KEY.test(key) && typeof value === "string") {
      safe[`${key.slice(0, -2)}Hash`] = hashLogId(value);
    } else if (/Ids$/i.test(key) && Array.isArray(value)) {
      safe[`${key.slice(0, -3)}Hashes`] = value.map((entry) => hashLogId(String(entry)));
    } else if (key === "claimOwner" && typeof value === "string") {
      safe.claimOwnerHash = hashLogId(value);
    } else {
      safe[key] = ringSafeValue(value);
    }
  }
  return safe;
}

function ringSafeRoutePath(path: string): string {
  return path.replace(
    /(\/(?:(?:api\/worker|admin\/dev)\/)?generation-requests\/|\/(?:artifacts|input-authorities|skills)\/)([^/]+)/gi,
    (_match, prefix: string, identifier: string) => `${prefix}[HASH:${hashLogId(identifier)}]`,
  );
}

function ringSafeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => ringSafeValue(entry));
  if (value && typeof value === "object") return ringSafeFields(value as FeedHostLogFields);
  if (typeof value === "string") {
    return value.replace(/did:[a-z0-9:._%-]+/gi, (identifier) => `[HASH:${hashLogId(identifier)}]`);
  }
  return value;
}

function hashLogId(value: string): string {
  return createHash("sha256").update(value || "unknown").digest("hex").slice(0, 12);
}

export function levelForStatus(status: number): FeedHostLogLevel {
  if (status >= 500) return "error";
  if (status >= 400) return "warn";
  return "info";
}
