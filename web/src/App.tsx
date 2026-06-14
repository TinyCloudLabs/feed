import { useCallback, useEffect, useRef, useState } from "react";
import { restoreSession, signOut } from "./tinycloud.ts";
import {
  agentConfigured,
  clearStoredDelegation,
  ensureDelegation,
} from "./agentClient.ts";
import { bootstrapSchema } from "./feedClient.ts";
import { navigate, useRoute } from "./router.tsx";
import type { Session } from "./session.ts";
import type { DelegationInfo, RunRecord } from "./pages/types.ts";
import { ConnectPage } from "./pages/Connect.tsx";
import { FeedPage } from "./pages/Feed.tsx";
import { ArticlePage } from "./pages/Article.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { PreferencesPage } from "./pages/Preferences.tsx";

const UNDO_MS = 8000;

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);
  const [delegation, setDelegation] = useState<DelegationInfo | null>(null);
  // Restore-on-mount gate: until the persisted-session check finishes we render
  // a brief "Restoring…" state instead of flashing the sign-in screen on every
  // reload / new tab. Starts true and flips false once restore resolves.
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // True while the agent auto-connect is in flight; carries any auto-delegate
  // failure (surfaced, not swallowed) so Connect/Agents can show it.
  const [agentConnecting, setAgentConnecting] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  // Bumped after a successful agent run so the feed re-reads the user's space.
  const [feedRefreshKey, setFeedRefreshKey] = useState(0);

  // Cards dismissed via "less" — hidden immediately, session-only (the
  // distill-preferences loop handles durable effects).
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [undo, setUndo] = useState<{ id: string } | null>(null);
  const undoTimer = useRef<number | null>(null);

  const hideCard = useCallback((id: string) => {
    setHidden((prev) => new Set(prev).add(id));
    setUndo({ id });
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), UNDO_MS);
  }, []);

  const pauseUndoTimer = useCallback(() => {
    if (undoTimer.current !== null) {
      window.clearTimeout(undoTimer.current);
      undoTimer.current = null;
    }
  }, []);
  const resumeUndoTimer = useCallback(() => {
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), UNDO_MS);
  }, []);

  const undoHide = useCallback(() => {
    setUndo((u) => {
      if (u) {
        setHidden((prev) => {
          const next = new Set(prev);
          next.delete(u.id);
          return next;
        });
      }
      return null;
    });
    if (undoTimer.current !== null) window.clearTimeout(undoTimer.current);
  }, []);

  const onSignOut = useCallback(() => {
    void signOut();
    clearStoredDelegation();
    setSession(null);
    setDelegation(null);
    setRuns([]);
    navigate({ kind: "connect" });
  }, []);

  // Auto-connect the agent: reuse a valid stored delegation or mint a fresh one,
  // with NO manual "look up agent" / "delegate" clicks. Runs after sign-in
  // (fresh OR restored) and on demand from Generate. A no-op when the agent
  // backend isn't configured. Errors are CAPTURED into agentError (surfaced by
  // Connect/Agents) rather than swallowed; the promise still rejects so callers
  // that await it (Generate) can abort the run.
  const ensureAgentDelegation = useCallback(async () => {
    if (!agentConfigured()) return;
    setAgentConnecting(true);
    setAgentError(null);
    try {
      const ack = await ensureDelegation();
      setDelegation({
        agentDid: ack.agentDid,
        delegationCid: ack.delegationCid,
        spaceId: ack.spaceId,
        expiresAt: ack.expiresAt,
      });
    } catch (e) {
      setAgentError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setAgentConnecting(false);
    }
  }, []);

  // Re-grant: drop the stored + in-memory delegation, then mint a fresh one.
  // The recovery affordance behind the otherwise-automatic agent connect.
  const reGrantAgent = useCallback(async () => {
    clearStoredDelegation();
    setDelegation(null);
    await ensureAgentDelegation();
  }, [ensureAgentDelegation]);

  // Local revoke: forget the delegation (stored + in-memory) without re-minting.
  // Client-side only — the contract has no server revoke endpoint in the MVP.
  const forgetDelegation = useCallback(() => {
    clearStoredDelegation();
    setDelegation(null);
  }, []);

  // Called by Connect after a FRESH sign-in: adopt the session, then auto-connect
  // the agent so the user lands ready-to-generate with zero agent clicks.
  const onSession = useCallback(
    (s: Session) => {
      setSession(s);
      // Fire-and-forget: the error (if any) lands in agentError; the rejection
      // here is already captured, so ignore it at the call site.
      ensureAgentDelegation().catch(() => {});
    },
    [ensureAgentDelegation],
  );

  // Restore-on-mount: rehydrate a persisted session WITHOUT a passkey prompt, so
  // reload / new tab / "continue reading" don't force a re-sign-in. On success
  // we also re-bootstrap the schema (idempotent) and auto-connect the agent —
  // the same ready state a fresh sign-in produces. A missing/expired session
  // falls through to Connect; a real restore failure is surfaced, not hidden.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const restored = await restoreSession();
        if (cancelled) return;
        if (restored) {
          await bootstrapSchema(restored.appsSpaceUri);
          if (cancelled) return;
          setSession(restored);
          ensureAgentDelegation().catch(() => {});
        }
      } catch (e) {
        if (!cancelled) setRestoreError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureAgentDelegation]);

  // While restore-on-mount is in flight, hold a brief "Restoring…" state instead
  // of flashing the sign-in screen. Once it resolves we either have a session
  // (render the route) or fall through to Connect.
  if (restoring) {
    return (
      <div className="feed-status">
        <p className="feed-status-line">Restoring session…</p>
        <p className="feed-status-sub">Reusing your saved sign-in</p>
        {restoreError && (
          <div className="feed-error" style={{ marginTop: 14 }}>{restoreError}</div>
        )}
      </div>
    );
  }

  // Every route except Connect requires a session. Send unauthenticated deep
  // links back to Connect rather than rendering a page with no session.
  const needsSession = route.kind !== "connect";
  if (needsSession && !session) {
    return (
      <ConnectPage
        session={session}
        delegation={delegation}
        onSession={onSession}
        onReGrant={reGrantAgent}
        agentConnecting={agentConnecting}
        agentError={agentError}
        restoreError={restoreError}
      />
    );
  }

  return (
    <>
      {route.kind === "connect" && (
        <ConnectPage
          session={session}
          delegation={delegation}
          onSession={onSession}
          onReGrant={reGrantAgent}
          agentConnecting={agentConnecting}
          agentError={agentError}
          restoreError={restoreError}
        />
      )}
      {route.kind === "feed" && session && (
        <FeedPage
          session={session}
          hidden={hidden}
          onHide={hideCard}
          onSignOut={onSignOut}
          refreshKey={feedRefreshKey}
        />
      )}
      {route.kind === "article" && session && (
        <ArticlePage slug={route.slug} session={session} onHide={hideCard} />
      )}
      {route.kind === "agents" && session && (
        <AgentsPage
          delegation={delegation}
          runs={runs}
          ensureDelegation={ensureAgentDelegation}
          onReGrant={reGrantAgent}
          onForget={forgetDelegation}
          agentConnecting={agentConnecting}
          agentError={agentError}
          onRunsChange={setRuns}
          onFeedRefresh={() => setFeedRefreshKey((k) => k + 1)}
        />
      )}
      {route.kind === "preferences" && session && (
        <PreferencesPage session={session} />
      )}

      <div role="status" aria-live="polite">
        {undo && (
          <div
            className="undo-toast"
            onMouseEnter={pauseUndoTimer}
            onMouseLeave={resumeUndoTimer}
            onFocus={pauseUndoTimer}
            onBlur={resumeUndoTimer}
          >
            <span className="undo-toast-text">Removed from feed</span>
            <button type="button" className="quiet-link" onClick={undoHide}>
              Undo
            </button>
          </div>
        )}
      </div>
    </>
  );
}
