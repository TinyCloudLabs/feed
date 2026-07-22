// Fire-and-forget error/event reporting to the Feed Host's structured log
// stream (/api/client-events). Browser failures — sign-in, delegation minting,
// feed setup — were previously invisible outside the devtools console; this
// makes them show up next to the host's own request logs.

import { FEED_HOST_URL } from "./config.ts";

export type ClientLogLevel = "info" | "warn" | "error";
export type ClientSessionMode = "fresh" | "restored";
export type DelegationFailureStage = "mint" | "submit" | "activate";
export type MissingParentRecoveryOutcome = "healed" | "reconnect_required";

export type ClientLogFields = {
  traceId?: string;
  phase?: string;
  durationMs?: number;
  elapsedMs?: number;
  activeElapsedMs?: number;
  session_mode?: ClientSessionMode;
  stage?: DelegationFailureStage;
  outcome?: MissingParentRecoveryOutcome;
};

export function buildClientEventPayload(
  level: ClientLogLevel,
  event: string,
  detail?: string,
  fields: ClientLogFields = {},
): Record<string, unknown> {
  return { level, event, detail: detail?.slice(0, 500), ...fields };
}

export function reportClientEvent(
  level: ClientLogLevel,
  event: string,
  detail?: string,
  actorId?: string,
  fields: ClientLogFields = {},
): void {
  try {
    void fetch(`${FEED_HOST_URL.replace(/\/+$/, "")}/api/client-events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(actorId ? { "x-feed-actor-id": actorId } : {}),
      },
      body: JSON.stringify(buildClientEventPayload(level, event, detail, fields)),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Reporting must never break the app.
  }
}

export function reportClientTiming(
  event: string,
  input: {
    traceId: string;
    phaseStartedAt: number;
    loginStartedAt: number;
    systemStartedAt?: number;
    systemElapsedBeforeApprovalMs?: number;
    actorId?: string;
    detail?: string;
    sessionMode: ClientSessionMode;
  },
): void {
  const now = performance.now();
  reportClientEvent("info", event, input.detail, input.actorId, {
    traceId: input.traceId,
    durationMs: Math.round(now - input.phaseStartedAt),
    elapsedMs: Math.round(now - input.loginStartedAt),
    ...(input.systemStartedAt === undefined
      ? {}
      : {
          activeElapsedMs: Math.round(
            (input.systemElapsedBeforeApprovalMs ?? 0) + now - input.systemStartedAt,
          ),
        }),
    session_mode: input.sessionMode,
  });
}

export function errorDetail(error: unknown): string {
  return describeError(error, new Set<object>(), 0).slice(0, 500);
}

function describeError(value: unknown, seen: Set<object>, depth: number): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "circular cause";
  if (depth >= 4) return "cause depth exceeded";
  seen.add(value);

  const name = safeStringField(value, "name");
  const code = safeStringField(value, "code");
  const message = safeStringField(value, "message");
  const label = name || (value instanceof Error ? value.name : undefined);
  const parts = [
    label,
    code ? `[${code}]` : undefined,
  ].filter(Boolean).join(" ");
  let detail = message
    ? `${parts ? `${parts}: ` : ""}${message}`
    : parts || "Unknown error";

  const cause = safeField(value, "cause");
  if (cause !== undefined && cause !== null) {
    detail += `; cause: ${describeError(cause, seen, depth + 1)}`;
  }
  return detail;
}

function safeField(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeStringField(value: object, key: string): string | undefined {
  const field = safeField(value, key);
  if (typeof field === "string" && field.trim()) return field.trim();
  if (key === "code" && typeof field === "number" && Number.isFinite(field)) return String(field);
  return undefined;
}

export function installGlobalErrorReporting(): void {
  window.addEventListener("error", (event) => {
    reportClientEvent("error", "window_error", event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportClientEvent("error", "unhandled_rejection", errorDetail(event.reason));
  });
}
