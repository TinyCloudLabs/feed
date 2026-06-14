// Connect.tsx — the `/` landing + onboarding flow.
//
// 1. OpenKey sign-in (broadened manifest → SIWE recap covers the agent scopes).
// 2. GET /agent/info → show the agent DID + the permissions it requests.
// 3. delegateTo(agentDid, AGENT_SCOPES) → serialize → POST /agent/delegation.
// 4. Show delegation status/expiry + a re-grant button, and a link to the feed.
//
// Gated behind agentConfigured(): with no VITE_AGENT_HOST, sign-in still works
// (the feed is readable) but the delegate step shows a clear "agent backend not
// configured" state instead of faking success.

import { useState } from "react";
import { signIn } from "../tinycloud.ts";
import { bootstrapSchema } from "../feedClient.ts";
import {
  agentConfigured,
  AGENT_HOST,
  delegateToAgent,
  getAgentInfo,
  type AgentInfo,
} from "../agentClient.ts";
import { Link } from "../router.tsx";
import type { Session } from "../session.ts";
import type { DelegationInfo } from "./types.ts";

export function ConnectPage({
  session,
  delegation,
  onSession,
  onDelegation,
}: {
  session: Session | null;
  delegation: DelegationInfo | null;
  onSession: (s: Session) => void;
  onDelegation: (d: DelegationInfo | null) => void;
}) {
  return (
    <>
      <header className="masthead">
        <div>
          <h1 className="masthead-title">Feed</h1>
          <p className="masthead-sub">xyz.tinycloud.artifacts</p>
        </div>
      </header>
      {!session ? (
        <SignInStep onSession={onSession} />
      ) : (
        <DelegateStep
          delegation={delegation}
          onDelegation={onDelegation}
        />
      )}
    </>
  );
}

function SignInStep({ onSession }: { onSession: (s: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const session = await signIn();
      // Owner-session bootstrap: idempotently create the feed + interactions
      // tables in the user's own space so the agent can publish, interaction
      // writes land, and the feed read doesn't hit a missing table.
      await bootstrapSchema(session.appsSpaceUri);
      onSession(session);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="feed-status">
      <p className="feed-status-line">Connect to read your feed.</p>
      <p className="feed-status-sub">Owner session · applications space</p>
      <button type="button" className="quiet-link" disabled={busy} onClick={() => void go()}>
        {busy ? "Connecting…" : "Sign in with OpenKey"}
      </button>
      {error && <div className="feed-error" style={{ marginTop: 14 }}>{error}</div>}
    </div>
  );
}

function DelegateStep({
  delegation,
  onDelegation,
}: {
  delegation: DelegationInfo | null;
  onDelegation: (d: DelegationInfo | null) => void;
}) {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(false);

  const loadInfo = async () => {
    setLoadingInfo(true);
    setError(null);
    try {
      setInfo(await getAgentInfo());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingInfo(false);
    }
  };

  const grant = async () => {
    setBusy(true);
    setError(null);
    try {
      // Fetch /agent/info FRESH on every grant/re-grant — never reuse a cached
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

  if (!agentConfigured()) {
    return (
      <div className="feed-status">
        <p className="feed-status-line">Agent backend not configured.</p>
        <p className="feed-status-sub">Set VITE_AGENT_HOST to enable generation</p>
        <p className="prefs-note">
          You're signed in. You can read the feed, but no agent is connected to
          generate new artifacts yet.
        </p>
        <Link to={{ kind: "feed" }} className="quiet-link" aria-label="Go to feed">
          Go to feed
        </Link>
      </div>
    );
  }

  if (delegation) {
    return (
      <div className="connect-panel">
        <DelegationCard delegation={delegation} />
        <div className="prefs-actions">
          <Link to={{ kind: "feed" }} className="quiet-link" aria-label="Go to feed">
            Go to feed
          </Link>
          <Link to={{ kind: "agents" }} className="quiet-link" aria-label="Manage agent">
            Manage agent
          </Link>
          <button
            type="button"
            className="quiet-link"
            disabled={busy}
            onClick={() => void grant()}
          >
            {busy ? "Re-granting…" : "Re-grant"}
          </button>
        </div>
        {error && <div className="feed-error" style={{ marginTop: 14 }}>{error}</div>}
      </div>
    );
  }

  return (
    <div className="connect-panel">
      <p className="feed-status-line connect-heading">Connect an agent.</p>
      <p className="feed-status-sub">{AGENT_HOST}</p>
      {!info ? (
        <div className="prefs-actions">
          <button
            type="button"
            className="quiet-link"
            disabled={loadingInfo}
            onClick={() => void loadInfo()}
          >
            {loadingInfo ? "Loading agent…" : "Look up agent"}
          </button>
        </div>
      ) : (
        <>
          <AgentDescriptor info={info} />
          <div className="prefs-actions">
            <button
              type="button"
              className="quiet-link"
              disabled={busy}
              onClick={() => void grant()}
            >
              {busy ? "Granting…" : "Delegate to agent"}
            </button>
          </div>
        </>
      )}
      {error && <div className="feed-error" style={{ marginTop: 14 }}>{error}</div>}
    </div>
  );
}

export function AgentDescriptor({ info }: { info: AgentInfo }) {
  return (
    <div className="prefs-section">
      <h3>{info.name}</h3>
      <p className="agent-did">{info.did}</p>
      <ul>
        {info.permissions.map((p, i) => (
          <li key={i} className="learned">
            <span className="prefs-text">
              {p.service} · {p.space ?? "applications"} · {p.path}
            </span>
            <span className="prefs-evidence">{p.actions.join(", ")}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DelegationCard({ delegation }: { delegation: DelegationInfo }) {
  const expires = new Date(delegation.expiresAt);
  const expiresLabel = Number.isNaN(expires.getTime())
    ? delegation.expiresAt
    : expires.toLocaleString();
  return (
    <div className="prefs-section">
      <h3>Delegation active</h3>
      <ul>
        <li className="learned">
          <span className="prefs-text">Agent</span>
          <span className="prefs-evidence">{delegation.agentDid}</span>
        </li>
        <li className="learned">
          <span className="prefs-text">Delegation</span>
          <span className="prefs-evidence">{delegation.delegationCid}</span>
        </li>
        <li className="learned">
          <span className="prefs-text">Space</span>
          <span className="prefs-evidence">{delegation.spaceId}</span>
        </li>
        <li className="learned">
          <span className="prefs-text">Expires</span>
          <span className="prefs-evidence">{expiresLabel}</span>
        </li>
      </ul>
    </div>
  );
}
