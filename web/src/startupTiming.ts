export type StartupFlow = "session_restore" | "interactive_sign_in" | "delegation_recovery";

export type StartupTimingEvent = {
  traceId: string;
  flow: StartupFlow;
  stage: string;
  phase: "start" | "end" | "mark" | "complete";
  clientTs: string;
  elapsedMs: number;
  durationMs?: number;
  outcome?: "ok" | "error" | "signed_out";
};

type TimingSink = (event: StartupTimingEvent) => void;

type TimingClock = {
  now: () => number;
  timestamp: () => string;
  id: () => string;
};

const browserClock: TimingClock = {
  now: () => performance.now(),
  timestamp: () => new Date().toISOString(),
  id: () => `feed_${crypto.randomUUID()}`,
};

export class StartupTrace {
  readonly traceId: string;
  readonly flow: StartupFlow;
  private readonly startedAt: number;
  private readonly openStages = new Map<string, number>();
  private readonly marks = new Set<string>();
  private finished = false;

  constructor(
    flow: StartupFlow,
    private readonly sink: TimingSink,
    private readonly clock: TimingClock = browserClock,
  ) {
    this.flow = flow;
    this.traceId = clock.id();
    this.startedAt = clock.now();
  }

  get active(): boolean {
    return !this.finished;
  }

  start(stage: string): void {
    if (this.finished || this.openStages.has(stage)) return;
    const now = this.clock.now();
    this.openStages.set(stage, now);
    this.emit({ stage, phase: "start", elapsedMs: now - this.startedAt });
  }

  end(stage: string, outcome: "ok" | "error" = "ok"): void {
    if (this.finished) return;
    const stageStartedAt = this.openStages.get(stage);
    if (stageStartedAt === undefined) return;
    this.openStages.delete(stage);
    const now = this.clock.now();
    this.emit({
      stage,
      phase: "end",
      elapsedMs: now - this.startedAt,
      durationMs: now - stageStartedAt,
      outcome,
    });
  }

  mark(stage: string): void {
    if (this.finished || this.marks.has(stage)) return;
    this.marks.add(stage);
    this.emit({ stage, phase: "mark", elapsedMs: this.clock.now() - this.startedAt });
  }

  async measure<T>(stage: string, operation: () => Promise<T>): Promise<T> {
    if (!this.active) return operation();
    this.start(stage);
    try {
      const result = await operation();
      this.end(stage, "ok");
      return result;
    } catch (error) {
      this.end(stage, "error");
      throw error;
    }
  }

  complete(outcome: "ok" | "error" | "signed_out"): void {
    if (this.finished) return;
    const now = this.clock.now();
    this.finished = true;
    this.emit({
      stage: "startup_total",
      phase: "complete",
      elapsedMs: now - this.startedAt,
      durationMs: now - this.startedAt,
      outcome,
    });
  }

  private emit(event: Omit<StartupTimingEvent, "traceId" | "flow" | "clientTs">): void {
    this.sink({
      traceId: this.traceId,
      flow: this.flow,
      clientTs: this.clock.timestamp(),
      ...event,
      elapsedMs: Math.round(event.elapsedMs),
      ...(event.durationMs === undefined ? {} : { durationMs: Math.round(event.durationMs) }),
    });
  }
}
