// Connect.tsx — the `/` landing + onboarding flow.
//
// 1. OpenKey sign-in (broadened manifest → SIWE recap covers the agent scopes).
// 2. The agent connects AUTOMATICALLY: App's onSession runs ensureDelegation
//    (GET /agent/info → delegateTo → POST /agent/delegation), reusing a stored
//    delegation when valid. No manual "look up agent" / "delegate" clicks.
// 3. This page reflects that state: connecting → delegation active + go-to-feed,
//    with a small "Re-grant" affordance for recovery.
//
// Gated behind agentConfigured(): with no agent host configured (runtime
// /agent-config.json, or VITE_AGENT_HOST in dev), sign-in still works (the feed is
// readable) but the delegate step shows a clear "agent backend not configured"
// state instead of faking success.

import { useState } from "react";
import { signIn } from "../tinycloud.ts";
import { bootstrapSchema } from "../feedClient.ts";
import { agentConfigured, agentHost } from "../agentClient.ts";
import { Link } from "../router.tsx";
import type { Session } from "../session.ts";
import type { DelegationInfo } from "./types.ts";

export function ConnectPage({
  session,
  delegation,
  onSession,
  onReGrant,
  agentConnecting,
  agentError,
  restoreError,
}: {
  session: Session | null;
  delegation: DelegationInfo | null;
  onSession: (s: Session) => void;
  /** Recovery: drop the stored delegation and mint a fresh one. */
  onReGrant: () => Promise<void>;
  /** True while the automatic agent connect is in flight. */
  agentConnecting: boolean;
  /** An auto-delegate failure surfaced from App (not swallowed). */
  agentError?: string | null;
  /** A restore-on-mount failure surfaced from App (corrupt/unexpected), shown
   *  alongside the sign-in button so the user understands why they're here. */
  restoreError?: string | null;
}) {
  return (
    <>
      <header className="masthead">
        <div>
          <h1 className="masthead-title">TinyFeed</h1>
          <p className="masthead-sub">xyz.tinycloud.artifacts</p>
        </div>
      </header>
      {!session ? (
        <SignInStep onSession={onSession} restoreError={restoreError} />
      ) : (
        <DelegateStep
          delegation={delegation}
          onReGrant={onReGrant}
          agentConnecting={agentConnecting}
          agentError={agentError}
        />
      )}
    </>
  );
}

function SignInStep({
  onSession,
  restoreError,
}: {
  onSession: (s: Session) => void;
  restoreError?: string | null;
}) {
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
      // App.onSession adopts the session AND auto-connects the agent.
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
      {(error || restoreError) && (
        <div className="feed-error" style={{ marginTop: 14 }}>{error ?? restoreError}</div>
      )}
    </div>
  );
}

function DelegateStep({
  delegation,
  onReGrant,
  agentConnecting,
  agentError,
}: {
  delegation: DelegationInfo | null;
  onReGrant: () => Promise<void>;
  agentConnecting: boolean;
  agentError?: string | null;
}) {
  // Re-grant is a recovery affordance; the happy-path delegation is automatic.
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

  if (!agentConfigured()) {
    return (
      <div className="feed-status">
        <p className="feed-status-line">Agent backend not configured.</p>
        <p className="feed-status-sub">Set a host in agent-config.json to enable generation</p>
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

  // Delegation in place (fresh or reused) → ready to read + generate.
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
            disabled={reGranting || agentConnecting}
            onClick={() => void reGrant()}
          >
            {reGranting ? "Re-granting…" : "Re-grant"}
          </button>
        </div>
        {agentError && <div className="feed-error" style={{ marginTop: 14 }}>{agentError}</div>}
      </div>
    );
  }

  // No delegation yet: the agent auto-connects on sign-in. While that's in
  // flight show a connecting state; if it FAILED, surface the error + a retry.
  return (
    <div className="connect-panel">
      <p className="feed-status-line connect-heading">
        {agentConnecting ? "Connecting agent…" : "Agent not connected."}
      </p>
      <p className="feed-status-sub">{agentHost()}</p>
      {!agentConnecting && (
        <div className="prefs-actions">
          <Link to={{ kind: "feed" }} className="quiet-link" aria-label="Go to feed">
            Go to feed
          </Link>
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
