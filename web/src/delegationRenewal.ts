// Feed Host delegations expire on a fixed clock (SESSION_EXPIRATION_MS) and
// nothing ever renewed them, so every background generation for a user died a
// fixed interval after their last sign-in. Minting is silent (session-key
// signed), so a restored session can re-mint and resubmit without a wallet
// prompt: expiry becomes "SESSION_EXPIRATION_MS since the last app open"
// instead of "since sign-in".
//
// This module owns the renewal decision (is one due?) and its telemetry. The
// mint + submit itself stays in auth.ts so the renewal reuses the existing
// retry ladders, error classification, and missing-parent recovery.

import type { FeedHostDelegationReceipt } from "./delegation.ts";
import {
  errorDetail,
  reportClientEvent,
  reportClientTiming,
  type ClientSessionMode,
} from "./clientLog.ts";
import { isFeedReconnectRequiredError } from "./authPolicy.ts";

// A renewal costs one silent mint plus one host round-trip. Once per app open
// is the intent; this floor keeps a long-lived tab (or a delegation-recovery
// restart re-running startFeed) from re-minting in a loop.
export const DELEGATION_RENEWAL_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type DelegationRenewalOutcome = "renewed" | "skipped" | "failed";

export type DelegationRenewalTrace = {
  traceId: string;
  loginStartedAt: number;
  sessionMode: ClientSessionMode;
};

type RenewalMark = { actorId: string; at: number };

let lastSubmission: RenewalMark | null = null;
let inFlight: { actorId: string; promise: Promise<DelegationRenewalOutcome> } | null = null;

/**
 * A fresh delegation reached the host through some other path (sign-in, setup,
 * recovery). It is as good as a renewal, so nothing is due yet.
 */
export function noteDelegationSubmitted(actorId: string, now: number = Date.now()): void {
  lastSubmission = { actorId, at: now };
}

/**
 * A restored session is a new app open, which is exactly what the rolling
 * window keys on: the next renewal is due regardless of what this tab did
 * before the reload.
 */
export function noteSessionRestored(): void {
  lastSubmission = null;
}

/** @internal Test seam. */
export function resetDelegationRenewalState(): void {
  lastSubmission = null;
  inFlight = null;
}

export function isDelegationRenewalDue(actorId: string, now: number = Date.now()): boolean {
  if (!lastSubmission || lastSubmission.actorId !== actorId) return true;
  return now - lastSubmission.at >= DELEGATION_RENEWAL_MIN_INTERVAL_MS;
}

/**
 * Idempotent: concurrent callers share one submission, and a renewal that
 * already happened for this actor within the interval is skipped. Ordinary
 * failures are reported and swallowed — the existing delegation is still
 * valid, so a failed renewal must never disturb a running feed. Session-scope
 * failures surface as FeedReconnectRequiredError for the caller's existing
 * reconnect handling.
 */
export async function renewDelegation(input: {
  actorId: string;
  submit: () => Promise<FeedHostDelegationReceipt[]>;
  trace?: DelegationRenewalTrace;
  now?: () => number;
}): Promise<DelegationRenewalOutcome> {
  const now = input.now ?? Date.now;
  if (inFlight?.actorId === input.actorId) return inFlight.promise;
  if (!isDelegationRenewalDue(input.actorId, now())) return "skipped";

  const sessionMode: ClientSessionMode = input.trace?.sessionMode ?? "restored";
  const phaseStartedAt = performance.now();
  const promise = (async (): Promise<DelegationRenewalOutcome> => {
    try {
      const [receipt] = await input.submit();
      noteDelegationSubmitted(input.actorId, now());
      reportClientTiming("delegation_renewed", {
        traceId: input.trace?.traceId ?? crypto.randomUUID(),
        loginStartedAt: input.trace?.loginStartedAt ?? phaseStartedAt,
        phaseStartedAt,
        actorId: input.actorId,
        sessionMode,
        detail: `setup=${receipt?.setup?.state ?? "unknown"}`,
      });
      return "renewed";
    } catch (error) {
      reportClientEvent("warn", "delegation_renewal_failed", errorDetail(error), input.actorId, {
        session_mode: sessionMode,
      });
      if (isFeedReconnectRequiredError(error)) throw error;
      return "failed";
    } finally {
      if (inFlight?.actorId === input.actorId) inFlight = null;
    }
  })();
  inFlight = { actorId: input.actorId, promise };
  return promise;
}
