import type { FeedControlIntentInput } from "./logic.ts";
import { logEvent, type FeedHostLogFields } from "./log.ts";
import { telemetryIdHash } from "./observability.ts";
import type { FeedHostActorStorage, FeedHostStorage } from "./storage.ts";

export const PROACTIVE_INTERVAL_MS = 60_000;
export const PROACTIVE_PROMPT = "Generate something useful from my latest authorized context.";

export type ProactiveResult = "ok" | "skipped_backlog" | "error";

export type ProactiveSchedulerState = {
  enabled: boolean;
  actorHash: string | null;
  lastEnsuredSlot: string | null;
  lastResult: ProactiveResult | null;
};

type EnsureResponse = {
  requestId?: string;
  duplicate?: boolean;
};

export type ProactiveSchedulerOptions = {
  actorId?: string | null;
  now?: () => Date;
  intervalMs?: number;
  ensureRequest: (event: FeedControlIntentInput) => Promise<EnsureResponse>;
  log?: (level: "info" | "warn" | "error", event: string, fields: FeedHostLogFields) => void;
};

/**
 * The timer is deliberately stateless. Durable request/control-intent rows and
 * the daily dedupe key are the scheduling authority across ticks and restarts.
 */
export class ProactiveDailyScheduler {
  private readonly actorId: string | null;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private readonly ensureRequest: ProactiveSchedulerOptions["ensureRequest"];
  private readonly log: NonNullable<ProactiveSchedulerOptions["log"]>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<ProactiveResult | "disabled"> | null = null;
  private state: ProactiveSchedulerState;

  constructor(options: ProactiveSchedulerOptions) {
    this.actorId = options.actorId?.trim() || null;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? PROACTIVE_INTERVAL_MS;
    this.ensureRequest = options.ensureRequest;
    this.log = options.log ?? logEvent;
    this.state = {
      enabled: this.actorId !== null,
      actorHash: this.actorId ? telemetryIdHash(this.actorId) : null,
      lastEnsuredSlot: null,
      lastResult: null,
    };
  }

  start(): void {
    if (!this.actorId || this.timer) return;
    void this.ensureCurrentSlot();
    this.timer = setInterval(() => void this.ensureCurrentSlot(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): ProactiveSchedulerState {
    return { ...this.state };
  }

  targetsActor(actorId: string): boolean {
    return this.actorId !== null && this.actorId.toLowerCase() === actorId.trim().toLowerCase();
  }

  ensureCurrentSlot(): Promise<ProactiveResult | "disabled"> {
    if (!this.actorId) return Promise.resolve("disabled");
    if (this.inFlight) return this.inFlight;
    const attempt = this.ensure(this.actorId, this.now());
    const tracked = attempt.finally(() => {
      if (this.inFlight === tracked) this.inFlight = null;
    });
    this.inFlight = tracked;
    return this.inFlight;
  }

  private async ensure(actorId: string, now: Date): Promise<ProactiveResult> {
    const slot = utcDailySlot(now);
    const actorHash = telemetryIdHash(actorId);
    let result: ProactiveResult;
    let errorCode: string | undefined;
    try {
      await this.ensureRequest(proactiveControlIntent(actorId, now));
      result = "ok";
      this.state.lastEnsuredSlot = slot;
    } catch (error) {
      errorCode = safeErrorCode(error);
      result = errorCode === "generation_backlog_full" ? "skipped_backlog" : "error";
    }
    this.state.lastResult = result;
    this.log(result === "error" ? "error" : result === "skipped_backlog" ? "warn" : "info", "proactive_enqueue", {
      actorHash,
      slot,
      resultCode: result,
      ...(errorCode ? { errorCode } : {}),
    });
    return result;
  }
}

export function utcDailySlot(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("proactive scheduler received an invalid clock value");
  return now.toISOString().slice(0, 10);
}

export function proactiveDedupeKey(now: Date): string {
  return `proactive:extract-insights:v1:${utcDailySlot(now)}`;
}

export function proactiveControlIntent(actorId: string, now: Date): FeedControlIntentInput {
  const slot = utcDailySlot(now);
  const attemptId = crypto.randomUUID();
  return {
    eventId: `proactive-${slot}-${attemptId}`,
    actorId,
    readerNonce: `proactive-${slot}-${attemptId}`,
    intentKind: "ask_feed",
    status: "accepted",
    targetRef: "feed",
    payload: { prompt: PROACTIVE_PROMPT, proactive: true },
    payloadHash: proactiveDedupeKey(now),
    createdAt: now.toISOString(),
  };
}

/**
 * Preserve the one-row-per-slot invariant even after that row becomes
 * terminal. New intake's general-purpose dedupe intentionally coalesces only
 * live work, so the daily scheduler first checks its durable slot across all
 * statuses, then uses the normal control-intent intake for an absent slot.
 */
export async function ensureProactiveGenerationRequest(
  storage: FeedHostStorage,
  actor: FeedHostActorStorage,
  event: FeedControlIntentInput,
): Promise<{ requestId?: string; duplicate: boolean }> {
  const dedupeKey = event.payloadHash;
  if (!dedupeKey) throw new Error("proactive control intent requires a daily dedupe key");
  const existing = await storage.findGenerationRequestByDedupeKey(actor, dedupeKey);
  if (existing) return { requestId: existing.requestId, duplicate: true };
  const recorded = await storage.recordControlIntent(actor, event);
  return { requestId: recorded.requestId, duplicate: recorded.duplicate };
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") {
    return "proactive_enqueue_failed";
  }
  return error.code.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 100) || "proactive_enqueue_failed";
}
