// useAgentBuild.ts — the shared "build the feed" controller used by BOTH the Feed
// page (the transient "Get updates" pill) and the Agents page (the "Generate the
// feed" button). It centralizes the run lifecycle so the two entry points behave
// identically and can't double-start a run:
//
//   • On mount it calls getActiveRun() (GET /agent/runs) to detect a build that's
//     already in flight — this tab, ANOTHER tab, or another session — and resumes
//     polling it. That cross-session detection is the whole point of the server
//     endpoint: a build kicked off elsewhere shows up here as "🛠 Building…".
//   • start() either ATTACHES to an already-active run or, when none is active,
//     ensures a delegation + POSTs /agent/run, then polls to completion. The
//     backend's shared run lock is authoritative; if a race still reaches POST,
//     startRun() converts 409 run_in_progress into the active run id.
//   • On terminal `done` it bumps the feed refresh key; on `error` it surfaces the
//     message. The poll is bounded + abortable (the existing pollRun contract); we
//     abort it on unmount so it can't setState after teardown.
//
// It reuses the existing helpers verbatim (ensureDelegation / startRun / pollRun /
// getActiveRun) and the AbortController poll-cancel pattern from Agents.tsx — no
// reinvented transport. The hook owns ONLY the orchestration + React state.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AgentNoDelegationError,
  agentConfigured,
  clearStoredDelegation,
  getActiveRun,
  pollRun,
  startRun,
  type StartRunResult,
  type RunState,
} from "./agentClient.ts";

/** What the hook reports about the current/last build. `live` mirrors the latest
 *  poll state (run id + status + published), so callers can render the run id and
 *  status in the building indicator. */
export interface AgentBuild {
  /** True while a run is queued/running (local OR resumed-from-server). Drives the
   *  "🛠 Building your feed…" indicator and the disabled/"Building…" button state. */
  building: boolean;
  /** Latest polled run state, or null when nothing has run this mount. */
  live: RunState | null;
  /** A user-facing run failure / transport error (not an abort). */
  error: string | null;
  /** Non-fatal run lifecycle visibility, e.g. stale delegation recovery. */
  notice: string | null;
  /** Start a build, or ATTACH to one already active (no duplicate POST). */
  start: () => Promise<void>;
}

export function useAgentBuild({
  ensureDelegation,
  onFeedRefresh,
  onRunStarted,
  onRunUpdate,
}: {
  /** App's auto-connect helper: reuse a stored delegation or mint one for THIS
   *  session's space. The Feed/Agents pages both pass the same App callback. */
  ensureDelegation: () => Promise<void>;
  /** Bump the feed refresh key once a build finishes `done`. */
  onFeedRefresh: () => void;
  /** Optional: a brand-new local run was POSTed (Agents prepends it to history). */
  onRunStarted?: (state: RunState) => void;
  /** Optional: a poll update for the active run (Agents updates its history row). */
  onRunUpdate?: (state: RunState) => void;
}): AgentBuild {
  const [building, setBuilding] = useState(false);
  const [live, setLive] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Mirror the caller callbacks into refs so drivePoll / the mount effect / start
  // stay STABLE even when a caller passes inline (non-memoized) callbacks — e.g.
  // Agents' onRunUpdate closes over its `runs` array and is recreated on every
  // history change. Without this, drivePoll would be recreated mid-poll and the
  // mount effect would re-fire, aborting and restarting the active-run poll on
  // every history tick. The refs always hold the LATEST callback; the identities
  // below never change. (ensureDelegation is consumed directly by start, which
  // intentionally depends on a stable App helper.)
  const onFeedRefreshRef = useRef(onFeedRefresh);
  const onRunStartedRef = useRef(onRunStarted);
  const onRunUpdateRef = useRef(onRunUpdate);
  onFeedRefreshRef.current = onFeedRefresh;
  onRunStartedRef.current = onRunStarted;
  onRunUpdateRef.current = onRunUpdate;

  // The in-flight poll's controller — aborted on unmount so the loop (and its
  // pending fetch + interval) stops and doesn't setState after teardown. Same
  // pattern as the old Agents GenerateSection.
  const pollAbort = useRef<AbortController | null>(null);
  // Guard against double-start within this tab: while a run is live locally we
  // hold its id here so a second start() attaches instead of POSTing again. (The
  // server endpoint guards the cross-tab case; this guards the same tab.)
  const activeRunId = useRef<string | null>(null);
  // SYNCHRONOUS in-tab single-flight: flipped true at the very top of start()
  // BEFORE any await, so a second start() in the same tick (double-click, both
  // pages mounted) can't slip past the guard while the first is still awaiting
  // getActiveRun/ensureDelegation/startRun. Reset when start() settles. This is
  // stricter than the async `building` state (which only updates next render).
  const starting = useRef(false);
  // True while mounted; flipped false on unmount so an aborted/late poll doesn't
  // setState after teardown. Checked before every setState in the poll path.
  const mounted = useRef(true);

  // Drive the poll for a known run id to terminal, wiring state + the refresh /
  // error side-effects. Shared by both "resume an existing run" (mount) and
  // "start a new run" (start()).
  const drivePoll = useCallback(
    async (runId: string, controller: AbortController) => {
      activeRunId.current = runId;
      if (mounted.current) setBuilding(true);
      try {
        const terminal = await pollRun(
          runId,
          (state) => {
            // Skip updates once unmounted/aborted — pollRun's last onUpdate can
            // land after the abort that ended the loop.
            if (mounted.current && !controller.signal.aborted) {
              setLive(state);
              onRunUpdateRef.current?.(state);
            }
          },
          { signal: controller.signal },
        );
        if (terminal.status === "done") {
          onFeedRefreshRef.current();
        } else if (terminal.status === "error" && mounted.current) {
          setError(terminal.error ?? "run failed");
        }
      } catch (e) {
        // A deliberate abort (unmount) is not a user-facing error.
        if (mounted.current && !(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (pollAbort.current === controller) pollAbort.current = null;
        if (activeRunId.current === runId) activeRunId.current = null;
        // Guard the building reset too: an unmounted/aborted poll must not
        // setState after teardown (React warns + it's a no-op leak).
        if (mounted.current) setBuilding(false);
      }
    },
    [],
  );

  // On mount: ask the server whether a build is already in flight (another tab/
  // session). If so, adopt it and resume polling. A 404/unreachable list endpoint
  // (older backend) degrades to "none active" inside getActiveRun — no throw, no
  // building state. A real auth/transport fault DOES throw and is surfaced.
  useEffect(() => {
    // Mark mounted at the START of every (re)mount — NOT just once — so React
    // StrictMode's mount→unmount→remount dev cycle (which runs this cleanup once)
    // doesn't leave `mounted.current === false` on the live component and suppress
    // every guarded setState. Standard mounted-ref pattern: set true on setup,
    // false on cleanup. This is the SINGLE place that flips `mounted`, and it also
    // aborts any in-flight poll on unmount.
    mounted.current = true;
    if (!agentConfigured()) {
      return () => {
        mounted.current = false;
        pollAbort.current?.abort();
      };
    }
    const controller = new AbortController();
    pollAbort.current?.abort();
    pollAbort.current = controller;
    void (async () => {
      try {
        const active = await getActiveRun(controller.signal);
        if (!active || controller.signal.aborted) return;
        // Seed `live` from the summary so the indicator shows the run id/status
        // immediately, then let drivePoll's first poll refine it.
        setLive({
          run_id: active.run_id,
          status: active.status,
          startedAt: active.startedAt,
          finishedAt: active.finishedAt,
          published: active.published,
          held: active.held,
          media: active.media,
          error: active.error,
          log: active.log,
        });
        await drivePoll(active.run_id, controller);
      } catch (e) {
        if (mounted.current && !(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      mounted.current = false;
      // Abort the LATEST controller (pollAbort.current), not just this effect's
      // `controller`: a start() after mount replaces pollAbort.current with its
      // own controller, and that start-spawned poll must also stop on unmount.
      pollAbort.current?.abort();
    };
  }, [drivePoll]);

  const start = useCallback(async () => {
    // Already building (local or resumed) — attach, don't POST a second run.
    // `starting` (synchronous ref) is the authoritative in-tab guard: it's set
    // BELOW before any await, so two start() calls in the same tick (double-click,
    // or both pages mounting) can't both pass — the async `building` state and
    // `activeRunId` (set only inside drivePoll, after awaits) update too late to
    // block a same-tick second caller on their own.
    if (starting.current || building || activeRunId.current) return;
    starting.current = true;
    setError(null);
    setNotice(null);
    const controller = new AbortController();
    pollAbort.current?.abort();
    pollAbort.current = controller;
    setBuilding(true);
    try {
      // Re-check the server before POSTing: a build may have started in another
      // tab between mount and this click. If so, attach to it.
      const active = await getActiveRun(controller.signal);
      if (active && !controller.signal.aborted) {
        setLive({
          run_id: active.run_id,
          status: active.status,
          startedAt: active.startedAt,
          finishedAt: active.finishedAt,
          published: active.published,
          held: active.held,
          media: active.media,
          error: active.error,
          log: active.log,
        });
        await drivePoll(active.run_id, controller);
        return;
      }
      // Ensure a delegation exists (auto-connect may have failed/been revoked).
      // ensureDelegation is the single-flight App helper, and preserves the
      // swapped-agent / space-binding guards (loadStoredDelegation + /agent/info).
      await ensureDelegation();
      // FINAL pre-POST re-check, immediately before startRun(): ensureDelegation
      // above awaits, widening the check-then-create window — re-poll so a run
      // that appeared during it is attached to without an extra POST. The backend
      // shared run lock is still the hard guarantee if two tabs race past this.
      const stillActive = await getActiveRun(controller.signal);
      if (stillActive && !controller.signal.aborted) {
        setLive({
          run_id: stillActive.run_id,
          status: stillActive.status,
          startedAt: stillActive.startedAt,
          finishedAt: stillActive.finishedAt,
          published: stillActive.published,
          held: stillActive.held,
          media: stillActive.media,
          error: stillActive.error,
          log: stillActive.log,
        });
        await drivePoll(stillActive.run_id, controller);
        return;
      }
      const startWithDelegationRecovery = async (): Promise<StartRunResult> => {
        try {
          return await startRun();
        } catch (e) {
          if (!(e instanceof AgentNoDelegationError)) throw e;
          // The browser can have a valid-looking ack while a restarted backend
          // has lost its active delegation. Drop the local ack, re-post a fresh
          // delegation through App's normal space/DID guards, then retry once.
          setNotice("Agent delegation was stale after a backend restart; reconnected and retried.");
          clearStoredDelegation();
          await ensureDelegation();
          return await startRun();
        }
      };

      const { run_id, status, attached } = await startWithDelegationRecovery();
      // startRun() isn't abortable, so the POST can complete AFTER an unmount/
      // sign-out. Guard before touching state or entering drivePoll, so we don't
      // setLive / fire onRunStarted / start a poll on a torn-down component. (The
      // run was created server-side; on the next mount getActiveRun() will pick it
      // up and resume it.)
      if (!mounted.current || controller.signal.aborted) return;
      const state: RunState = { run_id, status };
      setLive(state);
      if (!attached) onRunStartedRef.current?.(state);
      await drivePoll(run_id, controller);
    } catch (e) {
      if (mounted.current && !(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
      // drivePoll owns clearing `building` once it runs; if we threw BEFORE it
      // (ensure/startRun/getActiveRun failed), clear it here.
      if (pollAbort.current === controller) {
        pollAbort.current = null;
        if (mounted.current) setBuilding(false);
      }
    } finally {
      starting.current = false;
    }
  }, [building, drivePoll, ensureDelegation]);

  return { building, live, error, notice, start };
}
