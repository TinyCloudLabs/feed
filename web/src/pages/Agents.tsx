// Agents.tsx — the `/agents` page. Delegation status + re-grant/revoke, the
// Generate button (POST /agent/run → poll GET /agent/run/:id), and run history.
//
// "Revoke" here is client-side only (drops the local delegation + tells the user
// to re-grant); the contract has no revoke endpoint in the MVP, so we don't fake
// a server revoke — we surface what we can actually do.

import { useEffect, useRef, useState } from "react";
import {
  agentConfigured,
  AGENT_HOST,
  delegateToAgent,
  getAgentInfo,
  pollRun,
  startRun,
  type AgentInfo,
  type RunState,
} from "../agentClient.ts";
import { Shell } from "../Nav.tsx";
import { Link } from "../router.tsx";
import { AgentDescriptor, DelegationCard } from "./Connect.tsx";
import type { DelegationInfo, RunRecord } from "./types.ts";

export function AgentsPage({
  delegation,
  runs,
  onDelegation,
  onRunsChange,
  onFeedRefresh,
}: {
  delegation: DelegationInfo | null;
  runs: RunRecord[];
  onDelegation: (d: DelegationInfo | null) => void;
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
        <DelegationSection delegation={delegation} onDelegation={onDelegation} />
        <GenerateSection
          delegation={delegation}
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
  onDelegation,
}: {
  delegation: DelegationInfo | null;
  onDelegation: (d: DelegationInfo | null) => void;
}) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const grant = async () => {
    setBusy(true);
    setError(null);
    try {
      // ALWAYS fetch /agent/info fresh on every (re-)grant — never reuse a cached
      // DID — so a swapped backend agent DID is caught. delegateToAgent verifies
      // the ack's agentDid matches what we delegated to (+ VITE_AGENT_DID if set).
      const fresh = await getAgentInfo();
      setInfo(fresh);
      const { ack } = await delegateToAgent(fresh.did);
      onDelegation({
        agentDid: ack.agentDid,
        delegationCid: ack.delegationCid,
        spaceId: ack.spaceId,
        expiresAt: ack.expiresAt,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const lookup = async () => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await getAgentInfo());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (delegation) {
    return (
      <section>
        <DelegationCard delegation={delegation} />
        <div className="prefs-actions">
          <button type="button" className="quiet-link" disabled={busy} onClick={() => void grant()}>
            {busy ? "Re-granting…" : "Re-grant"}
          </button>
          <button
            type="button"
            className="quiet-link"
            onClick={() => onDelegation(null)}
            aria-label="Revoke delegation locally"
          >
            Revoke
          </button>
        </div>
        {error && <div className="feed-error" style={{ marginTop: 14 }}>{error}</div>}
      </section>
    );
  }

  return (
    <section>
      <div className="feed-status" style={{ padding: "26px 0" }}>
        <p className="feed-status-line">No delegation yet.</p>
        <p className="feed-status-sub">Delegate your scopes to the agent to generate</p>
      </div>
      {info && <AgentDescriptor info={info} />}
      <div className="prefs-actions">
        {!info ? (
          <button type="button" className="quiet-link" disabled={busy} onClick={() => void lookup()}>
            {busy ? "Loading agent…" : "Look up agent"}
          </button>
        ) : (
          <button type="button" className="quiet-link" disabled={busy} onClick={() => void grant()}>
            {busy ? "Granting…" : "Delegate to agent"}
          </button>
        )}
      </div>
      {error && <div className="feed-error" style={{ marginTop: 14 }}>{error}</div>}
    </section>
  );
}

function GenerateSection({
  delegation,
  runs,
  onRunsChange,
  onFeedRefresh,
}: {
  delegation: DelegationInfo | null;
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

  const disabled = running || !delegation;

  return (
    <section className="generate">
      <h3 className="prefs-section-title">Generate</h3>
      {!delegation && (
        <p className="prefs-note">Delegate to the agent above before generating.</p>
      )}
      <div className="prefs-actions">
        <button
          type="button"
          className={`quiet-link gen-control${running ? " gen-busy" : ""}`}
          disabled={disabled}
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
