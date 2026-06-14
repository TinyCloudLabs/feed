// Agents.tsx — the `/agents` page. Delegation status + re-grant/revoke, the
// Generate button (POST /agent/run → poll GET /agent/run/:id), and run history.
//
// The agent connects AUTOMATICALLY on sign-in (App.ensureAgentDelegation), so
// this page shows the resulting delegation rather than gating behind manual
// "look up"/"delegate" clicks. Generate just works: if the delegation is somehow
// missing when clicked, it auto-ensures one first, then starts the run.
//
// "Revoke" here is client-side only (drops the local delegation + tells the user
// to re-grant); the contract has no revoke endpoint in the MVP, so we don't fake
// a server revoke — we surface what we can actually do.

import { useEffect, useRef, useState } from "react";
import {
  agentConfigured,
  AGENT_HOST,
  pollRun,
  startRun,
  type RunState,
} from "../agentClient.ts";
import { Shell } from "../Nav.tsx";
import { Link } from "../router.tsx";
import { DelegationCard } from "./Connect.tsx";
import type { DelegationInfo, RunRecord } from "./types.ts";

export function AgentsPage({
  delegation,
  runs,
  ensureDelegation,
  onReGrant,
  onForget,
  agentConnecting,
  agentError,
  onRunsChange,
  onFeedRefresh,
}: {
  delegation: DelegationInfo | null;
  runs: RunRecord[];
  /** Auto-connect helper from App: reuse a stored delegation or mint one. */
  ensureDelegation: () => Promise<void>;
  /** Recovery: drop the stored delegation and mint a fresh one. */
  onReGrant: () => Promise<void>;
  /** Local revoke: forget the delegation without re-minting. */
  onForget: () => void;
  /** True while the automatic agent connect is in flight. */
  agentConnecting: boolean;
  /** An auto-delegate failure surfaced from App (not swallowed). */
  agentError?: string | null;
  onRunsChange: (runs: RunRecord[]) => void;
  /** Bump the feed refresh key after a successful run. */
  onFeedRefresh: () => void;
}) {
  if (!agentConfigured()) {
    return (
      <Shell title="Agents" sub="agent backend">
        <div className="feed-status">
          <p className="feed-status-line">Agent backend not configured.</p>
          <p className="feed-status-sub">Set VITE_AGENT_HOST to enable generation</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Agents" sub={AGENT_HOST}>
      <div className="agents">
        <DelegationSection
          delegation={delegation}
          onReGrant={onReGrant}
          onForget={onForget}
          agentConnecting={agentConnecting}
          agentError={agentError}
        />
        <GenerateSection
          delegation={delegation}
          ensureDelegation={ensureDelegation}
          runs={runs}
          onRunsChange={onRunsChange}
          onFeedRefresh={onFeedRefresh}
        />
        <RunHistory runs={runs} />
      </div>
    </Shell>
  );
}

function DelegationSection({
  delegation,
  onReGrant,
  onForget,
  agentConnecting,
  agentError,
}: {
  delegation: DelegationInfo | null;
  onReGrant: () => Promise<void>;
  onForget: () => void;
  agentConnecting: boolean;
  agentError?: string | null;
}) {
  const [reGranting, setReGranting] = useState(false);
  const reGrant = async () => {
    setReGranting(true);
    try {
      // Errors land in agentError (App captures them); ignore the rejection here.
      await onReGrant().catch(() => {});
    } finally {
      setReGranting(false);
    }
  };

  if (delegation) {
    return (
      <section>
        <DelegationCard delegation={delegation} />
        <div className="prefs-actions">
          <button
            type="button"
            className="quiet-link"
            disabled={reGranting || agentConnecting}
            onClick={() => void reGrant()}
          >
            {reGranting ? "Re-granting…" : "Re-grant"}
          </button>
          <button
            type="button"
            className="quiet-link"
            onClick={onForget}
            aria-label="Revoke delegation locally"
          >
            Revoke
          </button>
        </div>
        {agentError && <div className="feed-error" style={{ marginTop: 14 }}>{agentError}</div>}
      </section>
    );
  }

  // No delegation: it auto-connects on sign-in. Show the connecting state, or a
  // retry when the auto-connect failed.
  return (
    <section>
      <div className="feed-status" style={{ padding: "26px 0" }}>
        <p className="feed-status-line">
          {agentConnecting ? "Connecting agent…" : "Agent not connected."}
        </p>
        <p className="feed-status-sub">
          {agentConnecting
            ? "Delegating your scopes to the agent"
            : "Retry to delegate your scopes to the agent"}
        </p>
      </div>
      {!agentConnecting && (
        <div className="prefs-actions">
          <button
            type="button"
            className="quiet-link"
            disabled={reGranting}
            onClick={() => void reGrant()}
          >
            {reGranting ? "Connecting…" : "Connect agent"}
          </button>
        </div>
      )}
      {agentError && <div className="feed-error" style={{ marginTop: 14 }}>{agentError}</div>}
    </section>
  );
}

function GenerateSection({
  delegation,
  ensureDelegation,
  runs,
  onRunsChange,
  onFeedRefresh,
}: {
  delegation: DelegationInfo | null;
  /** Auto-connect helper: ensure a delegation exists before the run. */
  ensureDelegation: () => Promise<void>;
  runs: RunRecord[];
  onRunsChange: (runs: RunRecord[]) => void;
  onFeedRefresh: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [live, setLive] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The in-flight poll's controller — aborted on unmount/sign-out so the loop
  // (and its pending fetch + interval) stops and doesn't setState after unmount.
  const pollAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => pollAbort.current?.abort();
  }, []);

  const generate = async () => {
    setRunning(true);
    setError(null);
    setLive(null);
    const controller = new AbortController();
    pollAbort.current?.abort();
    pollAbort.current = controller;
    try {
      // Generate is just a button: if the delegation is somehow missing (auto-
      // connect failed or was revoked), ensure one first, then start the run.
      if (!delegation) await ensureDelegation();
      const { run_id, status } = await startRun();
      const record: RunRecord = {
        runId: run_id,
        status,
        startedAt: new Date().toISOString(),
      };
      // Prepend the new run; keep the rest of the history.
      let history = [record, ...runs];
      onRunsChange(history);
      setLive({ run_id, status });

      const terminal = await pollRun(
        run_id,
        (state) => {
          setLive(state);
          history = history.map((r) =>
            r.runId === state.run_id
              ? { ...r, status: state.status, published: state.published, error: state.error }
              : r,
          );
          onRunsChange(history);
        },
        { signal: controller.signal },
      );

      if (terminal.status === "done") {
        onFeedRefresh();
      } else if (terminal.status === "error") {
        setError(terminal.error ?? "run failed");
      }
    } catch (e) {
      // A deliberate abort (unmount/sign-out) is not a user-facing error.
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (pollAbort.current === controller) pollAbort.current = null;
      setRunning(false);
    }
  };

  return (
    <section className="generate">
      <h3 className="prefs-section-title">Generate</h3>
      <div className="prefs-actions">
        <button
          type="button"
          className={`quiet-link gen-control${running ? " gen-busy" : ""}`}
          disabled={running}
          onClick={() => void generate()}
        >
          {running ? <span className="gen-spinner" aria-hidden="true" /> : null}
          {running ? "Generating…" : "Generate"}
        </button>
      </div>
      {live && (
        <p className="gen-progress-meta" role="status">
          run {live.run_id} · {live.status}
          {live.published?.length ? ` · ${live.published.length} published` : ""}
        </p>
      )}
      {error && <div className="feed-error" style={{ marginTop: 14 }}>{error}</div>}
    </section>
  );
}

function RunHistory({ runs }: { runs: RunRecord[] }) {
  if (runs.length === 0) return null;
  return (
    <section className="prefs-section">
      <h3>Run history</h3>
      <ul>
        {runs.map((r) => (
          <li key={r.runId} className="learned">
            <span className="prefs-text">
              {r.status}
              {r.published?.length ? ` · ${r.published.length} artifact${r.published.length === 1 ? "" : "s"}` : ""}
            </span>
            <span className="prefs-evidence">
              {new Date(r.startedAt).toLocaleString()} · {r.runId}
              {r.error ? ` · ${r.error}` : ""}
            </span>
            {r.published?.length ? (
              <span className="run-published">
                {r.published.map((p) => (
                  <Link
                    key={p.slug}
                    to={{ kind: "article", slug: p.slug }}
                    className="tag"
                    aria-label={`Open ${p.slug}`}
                  >
                    {p.slug}
                  </Link>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
