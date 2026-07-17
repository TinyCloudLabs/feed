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
