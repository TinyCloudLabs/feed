// Agents.tsx — the `/agents` page. The PRIMARY action is now a prominent
// "Generate the feed" button (spec §3); everything else — the agent's DID +
// requested permissions, the delegation card with re-grant/revoke, and the run
// history — is collapsed under a native <details> disclosure (collapsed by
// default) so the page leads with the one thing a user comes here to do.
//
// The agent connects AUTOMATICALLY on sign-in (App.ensureAgentDelegation), so the
// delegation details show the resulting state rather than gating behind manual
// "look up"/"delegate" clicks. Generate just works: it ensures a delegation first
// if one is somehow missing, then starts the run.
//
// In-progress detection (spec §4): the page uses the shared useAgentBuild
// controller, which on mount calls getActiveRun() (GET /agent/runs) to catch a
// build started in ANOTHER tab/session and resume polling it. While a build is in
// flight the Generate button reflects "Building…" (disabled) rather than starting
// a duplicate run.
//
// "Revoke" here is client-side only (drops the local delegation + tells the user
// to re-grant); the contract has no revoke endpoint in the MVP, so we don't fake
// a server revoke — we surface what we can actually do.

import { useCallback, useEffect, useState } from "react";
import {
  agentConfigured,
  agentHost,
  getAgentInfo,
  getRunLock,
  type AgentInfo,
  type RunLockSummary,
  type RunState,
} from "../agentClient.ts";
import { useAgentBuild } from "../useAgentBuild.ts";
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
          <p className="feed-status-sub">Set a host in agent-config.json to enable generation</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="Agents" sub={agentHost()}>
      <AgentsBody
        delegation={delegation}
        runs={runs}
        ensureDelegation={ensureDelegation}
        onReGrant={onReGrant}
        onForget={onForget}
        agentConnecting={agentConnecting}
        agentError={agentError}
        onRunsChange={onRunsChange}
        onFeedRefresh={onFeedRefresh}
      />
    </Shell>
  );
}

/** Split out so the build controller hook only mounts once `agentConfigured()` is
 *  true (the not-configured branch above returns before any hook runs). */
function AgentsBody({
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
  ensureDelegation: () => Promise<void>;
  onReGrant: () => Promise<void>;
  onForget: () => void;
  agentConnecting: boolean;
  agentError?: string | null;
  onRunsChange: (runs: RunRecord[]) => void;
  onFeedRefresh: () => void;
}) {
  // The Agents page keeps a run HISTORY, so it threads onRunStarted (prepend a new
  // record) and onRunUpdate (update the live record) into the shared controller —
  // the same history-maintenance the old GenerateSection did inline, now driven by
  // the controller's poll so a resumed cross-tab run also lands in history.
  const onRunStarted = useCallback(
    (state: RunState) => {
      onRunsChange([
        {
          runId: state.run_id,
          status: state.status,
          startedAt: isoFromEpoch(state.startedAt) ?? new Date().toISOString(),
          finishedAt: isoFromEpoch(state.finishedAt),
          published: state.published,
          error: state.error,
          log: state.log,
        },
        ...runs,
      ]);
    },
    [onRunsChange, runs],
  );
  const onRunUpdate = useCallback(
    (state: RunState) => {
      // Update an existing record, or insert one (a resumed cross-tab run we never
      // saw start) so its status/published land in history too.
      const existing = runs.some((r) => r.runId === state.run_id);
      const next = existing
        ? runs.map((r) =>
            r.runId === state.run_id
              ? {
                  ...r,
                  status: state.status,
                  finishedAt: isoFromEpoch(state.finishedAt) ?? r.finishedAt,
                  published: state.published,
                  error: state.error,
                  log: state.log,
                }
              : r,
          )
        : [
            {
              runId: state.run_id,
              status: state.status,
              startedAt: isoFromEpoch(state.startedAt) ?? new Date().toISOString(),
              finishedAt: isoFromEpoch(state.finishedAt),
              published: state.published,
              error: state.error,
              log: state.log,
            },
            ...runs,
          ];
      onRunsChange(next);
    },
    [onRunsChange, runs],
  );

  const build = useAgentBuild({ ensureDelegation, onFeedRefresh, onRunStarted, onRunUpdate });

  return (
    <div className="agents">
      <GenerateSection build={build} />

      {/* Everything secondary lives under Details, collapsed by default (spec §3):
          the agent DID + requested permissions, the delegation card with the
          re-grant/revoke affordances, and the run history. */}
      <details className="agents-details">
        <summary>Details</summary>
        <AgentInfoSection />
        <DelegationSection
          delegation={delegation}
          onReGrant={onReGrant}
          onForget={onForget}
          agentConnecting={agentConnecting}
          agentError={agentError}
        />
        <RunLockSection
          polling={build.building}
          refreshKey={`${build.live?.run_id ?? "none"}:${build.live?.status ?? "idle"}:${runs.length}`}
        />
        <RunHistory runs={runs} />
      </details>
    </div>
  );
}

/** The prominent primary action: "Generate the feed". Reflects the shared build
 *  controller's state — disabled + "Building…" while a run is in flight (local OR
 *  resumed from another tab/session) so it can't start a duplicate. */
function GenerateSection({ build }: { build: ReturnType<typeof useAgentBuild> }) {
  const emptyDone =
    !build.building &&
    build.live?.status === "done" &&
    (build.live.published?.length ?? 0) === 0 &&
    !build.error;

  return (
    <section className="generate">
      <button
        type="button"
        className={`generate-primary${build.building ? " gen-busy" : ""}`}
        disabled={build.building}
        onClick={() => void build.start()}
      >
        {build.building ? <span className="gen-spinner" aria-hidden="true" /> : null}
        {build.building ? "Building…" : "Generate the feed"}
      </button>
      {build.building && (
        <div className="gen-progress" role="status">
          <p className="gen-progress-meta">
            Building your feed…
            {build.live ? ` · ${build.live.run_id} · ${build.live.status}` : ""}
          </p>
          <RunLog log={build.live?.log} />
        </div>
      )}
      {emptyDone && (
        <div className="feed-notice" role="status" style={{ marginTop: 14 }}>
          Finished, but no artifacts were published. Add transcripts to Listen, then generate again.
        </div>
      )}
      {build.error && <div className="feed-error" style={{ marginTop: 14 }}>{build.error}</div>}
    </section>
  );
}

/** The agent's identity + the scopes it requests, fetched from GET /agent/info.
 *  Lives under Details (spec §3). A fetch failure surfaces (not swallowed). */
function AgentInfoSection() {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const i = await getAgentInfo();
        if (!cancelled) setInfo(i);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <section className="prefs-section">
        <h3>Agent</h3>
        <div className="feed-error">{error}</div>
      </section>
    );
  }
  if (!info) {
    return (
      <section className="prefs-section">
        <h3>Agent</h3>
        <p className="prefs-note">Loading agent info…</p>
      </section>
    );
  }
  return (
    <section className="prefs-section">
      <h3>Agent</h3>
      <ul>
        <li className="learned">
          <span className="prefs-text">{info.name || "Agent"}</span>
          <span className="prefs-evidence">{info.did}</span>
        </li>
      </ul>
      {info.generation && (
        <>
          <h3>Generation</h3>
          <ul>
            <li className="learned">
              <span className="prefs-text">Target artifacts</span>
              <span className="prefs-evidence">
                Up to {info.generation.targetArtifacts} publishable Feed artifact
                {info.generation.targetArtifacts === 1 ? "" : "s"} per run
              </span>
            </li>
            <li className="learned">
              <span className="prefs-text">Transcript window</span>
              <span className="prefs-evidence">
                {info.generation.transcriptCount} Listen transcript
                {info.generation.transcriptCount === 1 ? "" : "s"} per run
              </span>
            </li>
            <li className="learned">
              <span className="prefs-text">Model</span>
              <span className="prefs-evidence">{info.generation.model}</span>
            </li>
            {info.generation.media?.images && (
              <li className="learned">
                <span className="prefs-text">Hero images</span>
                <span className="prefs-evidence">
                  {info.generation.media.images.enabled ? "Enabled" : "Disabled"} ·{" "}
                  {info.generation.media.images.reason}
                </span>
              </li>
            )}
            {info.generation.media?.video && (
              <li className="learned">
                <span className="prefs-text">Video clips</span>
                <span className="prefs-evidence">
                  {info.generation.media.video.enabled ? "Enabled" : "Disabled"} ·{" "}
                  {info.generation.media.video.reason}
                </span>
              </li>
            )}
          </ul>
        </>
      )}
      <h3>Requested permissions</h3>
      <ul>
        {info.permissions.map((p, i) => (
          <li key={`${p.service}:${p.path}:${i}`} className="learned">
            <span className="prefs-text">
              {p.service} · {p.actions.join(", ")}
            </span>
            <span className="prefs-evidence">
              {p.space}/{p.path}
              {p.description ? ` — ${p.description}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
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

function RunLockSection({ polling, refreshKey }: { polling: boolean; refreshKey: string }) {
  const [lock, setLock] = useState<RunLockSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await getRunLock(controller.signal);
        if (!controller.signal.aborted) {
          setLock(next);
          setError(null);
          setLoaded(true);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          setLoaded(true);
        }
      }
    };
    void load();
    const interval = polling ? window.setInterval(() => void load(), 5000) : undefined;
    return () => {
      if (interval !== undefined) window.clearInterval(interval);
      controller.abort();
    };
  }, [polling, refreshKey]);

  if (error) {
    return (
      <section className="prefs-section">
        <h3>Run lock</h3>
        <div className="feed-error">{error}</div>
      </section>
    );
  }

  if (!loaded) {
    return (
      <section className="prefs-section">
        <h3>Run lock</h3>
        <p className="prefs-note">Loading run lock…</p>
      </section>
    );
  }

  if (!lock) {
    return (
      <section className="prefs-section">
        <h3>Run lock</h3>
        <p className="prefs-note">No active run lock.</p>
      </section>
    );
  }

  return (
    <section className="prefs-section">
      <h3>Run lock</h3>
      <ul>
        <li className="learned">
          <span className="prefs-text">
            {lock.reclaimable ? "reclaimable" : "held"} · {lock.owner}
          </span>
          <span className="prefs-evidence">
            {lock.run_id} · pid {lock.pid} · {formatDuration(lock.ageMs)}
          </span>
        </li>
      </ul>
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
              {r.status === "done"
                ? ` · ${r.published?.length ?? 0} artifact${(r.published?.length ?? 0) === 1 ? "" : "s"}`
                : r.published?.length
                  ? ` · ${r.published.length} artifact${r.published.length === 1 ? "" : "s"}`
                  : ""}
            </span>
            <span className="prefs-evidence">
              {new Date(r.startedAt).toLocaleString()} · {r.runId}
              {r.error ? ` · ${r.error}` : ""}
            </span>
            <RunLog log={r.log} />
            {r.published?.length ? (
              <span className="run-published">
                {r.published.map((p) => (
                  <span key={`${p.type}/${p.slug}`} className="run-artifact">
                    <Link
                      to={{ kind: "article", slug: p.slug }}
                      className="tag"
                      aria-label={`Open ${p.slug}`}
                    >
                      {p.slug}
                    </Link>
                    <MediaBadges artifact={p} />
                  </span>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MediaBadges({ artifact }: { artifact: NonNullable<RunRecord["published"]>[number] }) {
  const media = artifact.media;
  if (!media) return null;
  const badges = [
    media.heroImage ? "image" : null,
    media.audio ? "audio" : null,
    media.video ? "video" : null,
  ].filter(Boolean);
  if (badges.length === 0) return <span className="run-media muted">no media</span>;
  return <span className="run-media">{badges.join(" · ")}</span>;
}

function isoFromEpoch(value: number | undefined): string | undefined {
  return typeof value === "number" ? new Date(value).toISOString() : undefined;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown age";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "less than 1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${hours} hr` : `${hours} hr ${rem} min`;
}

function RunLog({ log }: { log?: string[] }) {
  const tail = log?.slice(-6) ?? [];
  if (tail.length === 0) return null;
  return (
    <ol className="run-log-tail" aria-label="Recent run activity">
      {tail.map((line, index) => (
        <li key={`${index}:${line}`}>{line}</li>
      ))}
    </ol>
  );
}
