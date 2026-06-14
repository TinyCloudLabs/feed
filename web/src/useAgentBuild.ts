// useAgentBuild.ts — the shared "build the feed" controller used by BOTH the Feed
// page (the transient "Get updates" pill) and the Agents page (the "Generate the
// feed" button). It centralizes the run lifecycle so the two entry points behave
// identically and can't double-start a run:
//
//   • On mount it calls getActiveRun() (GET /agent/runs) to detect a build that's
//     already in flight — this tab, ANOTHER tab, or another session — and resumes
//     polling it. That cross-session detection is the whole point of the server
//     endpoint: a build kicked off elsewhere shows up here as "🛠 Building…".
//   • start() either ATTACHES to that already-active run or, when none is active,
//     ensures a delegation + POSTs /agent/run, then polls to completion. It never
//     POSTs a second run while one is live (local in-flight OR server-reported).
//   • On terminal `done` it bumps the feed refresh key; on `error` it surfaces the
//     message. The poll is bounded + abortable (the existing pollRun contract); we
//     abort it on unmount so it can't setState after teardown.
//
// It reuses the existing helpers verbatim (ensureDelegation / startRun / pollRun /
// getActiveRun) and the AbortController poll-cancel pattern from Agents.tsx — no
// reinvented transport. The hook owns ONLY the orchestration + React state.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  agentConfigured,
  getActiveRun,
  pollRun,
  startRun,
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

  // Drive the poll for a known run id to terminal, wiring state + the refresh /
  // error side-effects. Shared by both "resume an existing run" (mount) and
  // "start a new run" (start()).
  const drivePoll = useCallback(
    async (runId: string, controller: AbortController) => {
      activeRunId.current = runId;
      setBuilding(true);
      try {
        const terminal = await pollRun(
          runId,
          (state) => {
            setLive(state);
            onRunUpdateRef.current?.(state);
          },
          { signal: controller.signal },
        );
        if (terminal.status === "done") {
          onFeedRefreshRef.current();
        } else if (terminal.status === "error") {
          setError(terminal.error ?? "run failed");
        }
      } catch (e) {
        // A deliberate abort (unmount) is not a user-facing error.
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (pollAbort.current === controller) pollAbort.current = null;
        if (activeRunId.current === runId) activeRunId.current = null;
        setBuilding(false);
      }
    },
    [],
  );

  // On mount: ask the server whether a build is already in flight (another tab/
  // session). If so, adopt it and resume polling. A 404/unreachable list endpoint
  // (older backend) degrades to "none active" inside getActiveRun — no throw, no
  // building state. A real auth/transport fault DOES throw and is surfaced.
  useEffect(() => {
    if (!agentConfigured()) return;
    const controller = new AbortController();
    pollAbort.current?.abort();
    pollAbort.current = controller;
    void (async () => {
      try {
        const active = await getActiveRun(controller.signal);
        if (!active || controller.signal.aborted) return;
        // Seed `live` from the summary so the indicator shows the run id/status
        // immediately, then let drivePoll's first poll refine it.
        setLive({ run_id: active.run_id, status: active.status, published: active.published });
        await drivePoll(active.run_id, controller);
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => controller.abort();
  }, [drivePoll]);

  const start = useCallback(async () => {
    // Already building (local or resumed) — attach, don't POST a second run.
    if (building || activeRunId.current) return;
    setError(null);
    const controller = new AbortController();
    pollAbort.current?.abort();
    pollAbort.current = controller;
    setBuilding(true);
    try {
      // Re-check the server right before POSTing: a build may have started in
      // another tab between mount and this click. If so, attach to it.
      const active = await getActiveRun(controller.signal);
      if (active && !controller.signal.aborted) {
        setLive({ run_id: active.run_id, status: active.status, published: active.published });
        await drivePoll(active.run_id, controller);
        return;
      }
      // Ensure a delegation exists (auto-connect may have failed/been revoked),
      // then POST a fresh run. ensureDelegation is the single-flight App helper.
      await ensureDelegation();
      const { run_id, status } = await startRun();
      const state: RunState = { run_id, status };
      setLive(state);
      onRunStartedRef.current?.(state);
      await drivePoll(run_id, controller);
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
      // drivePoll owns clearing `building` once it runs; if we threw BEFORE it
      // (ensure/startRun/getActiveRun failed), clear it here.
      if (pollAbort.current === controller) {
        pollAbort.current = null;
        setBuilding(false);
      }
    }
  }, [building, drivePoll, ensureDelegation]);

  // Belt-and-suspenders: abort any live poll on final unmount (the mount effect's
  // cleanup already aborts its own controller; this also covers a start()-spawned
  // controller that outlives that effect).
  useEffect(() => () => pollAbort.current?.abort(), []);

  return { building, live, error, start };
}
