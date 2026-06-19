import { useCallback, useEffect, useRef, useState } from "react";
import { restoreSession, signOut, type SessionRestoreTrace } from "./tinycloud.ts";
import {
  agentConfigured,
  clearStoredDelegation,
  ensureDelegation,
} from "./agentClient.ts";
import { bootstrapSchema } from "./feedClient.ts";
import { navigate, parseRoute, useRoute } from "./router.tsx";
import type { Session } from "./session.ts";
import type { DelegationInfo, RunRecord } from "./pages/types.ts";
import { ConnectPage } from "./pages/Connect.tsx";
import { FeedPage } from "./pages/Feed.tsx";
import { ArticlePage } from "./pages/Article.tsx";
import { AgentsPage } from "./pages/Agents.tsx";
import { PreferencesPage } from "./pages/Preferences.tsx";

const UNDO_MS = 8000;

function restoreStageLabel(trace: SessionRestoreTrace): string {
  switch (trace.stage) {
    case "read-address":
      return "Checking saved sign-in";
    case "address-result":
      return trace.hasAddress ? "Saved sign-in found" : "No saved sign-in";
    case "sdk-created":
      return "Preparing TinyCloud session";
    case "sdk-restore-start":
      return "Restoring TinyCloud session";
    case "sdk-restore-result":
      return trace.status ? `TinyCloud restore: ${trace.status}` : "TinyCloud restore finished";
    case "space-ready":
      return "Applications space ready";
    case "stale-address-cleared":
      return trace.status ? `Cleared stale saved sign-in: ${trace.status}` : "Cleared stale saved sign-in";
    case "restore-failed":
      return trace.status ? `Restore failed: ${trace.status}` : "Restore failed";
    default:
      return trace.stage;
  }
}

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);
  // Live mirror of `session` for the stable ensureAgentDelegation callback: the
  // re-grant / Generate paths need the CURRENT session's space without depending
  // on a stale closure. Sign-in / restore pass the space explicitly (no ref-
  // timing gap right after they resolve).
  const sessionRef = useRef<Session | null>(null);
  const [delegation, setDelegation] = useState<DelegationInfo | null>(null);
  // Restore-on-mount gate: until the persisted-session check finishes we render
  // a brief "Restoring…" state instead of flashing the sign-in screen on every
  // reload / new tab. Starts true and flips false once restore resolves.
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreStatus, setRestoreStatus] = useState("Checking saved sign-in");
  const [restoreTrace, setRestoreTrace] = useState<SessionRestoreTrace[]>([]);
  // True while the agent auto-connect is in flight; carries any auto-delegate
  // failure (surfaced, not swallowed) so Connect/Agents can show it.
  const [agentConnecting, setAgentConnecting] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  // Bumped after a successful agent run so the feed re-reads the user's space.
  const [feedRefreshKey, setFeedRefreshKey] = useState(0);
  // Stable refresh callback so the build controller's poll effect (which depends
  // on it) isn't re-created on every App render.
  const bumpFeedRefresh = useCallback(() => setFeedRefreshKey((k) => k + 1), []);

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
    // Clear local restore pointers up front so a signOut() rejection can't leave
    // a restorable session; signOut() also clears them internally (defense in
    // depth). Swallow only the signOut rejection here — the pointers are gone.
    clearStoredDelegation();
    sessionRef.current = null;
    signOut().catch(() => {});
    setSession(null);
    setDelegation(null);
    setRuns([]);
    navigate({ kind: "connect" });
  }, []);

  // Auto-connect the agent: reuse a valid stored delegation (bound to THIS
  // session's space) or mint a fresh one, with NO manual "look up agent" /
  // "delegate" clicks. Runs after sign-in (fresh OR restored) and on demand from
  // Generate. `spaceUri` is the active session's applications-space URI — passed
  // explicitly by sign-in/restore, else read from sessionRef for re-grant/
  // Generate. A no-op when the agent backend isn't configured or there's no
  // session. Errors are CAPTURED into agentError (surfaced by Connect/Agents)
  // rather than swallowed; the promise still rejects so callers that await it
  // (Generate) can abort the run.
  const ensureAgentDelegation = useCallback(async (spaceUri?: string) => {
    if (!agentConfigured()) return;
    const space = spaceUri ?? sessionRef.current?.appsSpaceUri;
    if (!space) return;
    setAgentConnecting(true);
    setAgentError(null);
    try {
      const ack = await ensureDelegation(space);
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

  // Called by Connect after a FRESH sign-in: adopt the session, land the user on
  // the feed, and auto-connect the agent IN THE BACKGROUND so they see their feed
  // immediately rather than the delegate screen.
  const onSession = useCallback(
    (s: Session) => {
      sessionRef.current = s;
      setSession(s);
      // Sign-in lands on the feed (spec §1) — but HONOR a deep link: an
      // unauthenticated /agents or /a/:slug renders ConnectPage as a fallback, so
      // after sign-in the user should return to where they were headed. Mirror the
      // restore-on-mount guard: read the live pathname once and only redirect when
      // it's the DEFAULT connect route ("/"). The feed must NOT block on the agent
      // delegation below (it reads the user's space directly; a missing delegation
      // only affects Generate, which auto-ensures one when clicked).
      if (parseRoute(location.pathname).kind === "connect") {
        navigate({ kind: "feed" });
      }
      // Fire-and-forget: the error (if any) lands in agentError; the rejection
      // here is already captured, so ignore it at the call site. Pass the space
      // explicitly so the delegation binds to THIS session.
      ensureAgentDelegation(s.appsSpaceUri).catch(() => {});
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
        const restored = await restoreSession((trace) => {
          if (cancelled) return;
          setRestoreTrace((prev) => [...prev, trace]);
          setRestoreStatus(restoreStageLabel(trace));
        });
        if (cancelled) return;
        if (restored) {
          sessionRef.current = restored;
          setSession(restored);
          setRestoring(false);
          // A restored session should also land on the feed (spec §1) — but
          // ONLY when there's no deeper intent: if the user deep-linked to a
          // specific route (/agents, /a/:slug, …) we honor it. We read the live
          // pathname here (one-shot, at restore time) rather than the routed
          // state so this can't re-run on later navigation. Only the DEFAULT
          // connect route ("/") is redirected to the feed.
          if (parseRoute(location.pathname).kind === "connect") {
            navigate({ kind: "feed" });
          }
          // Do not hold the whole app on idempotent schema bootstrap after the
          // session is already restored. Run it in the background, log timing,
          // and refresh the feed when it completes.
          const bootstrapStarted = performance.now();
          console.info("[TinyFeed restore]", { stage: "schema-bootstrap-start", elapsedMs: 0 });
          bootstrapSchema(restored.appsSpaceUri)
            .then(({ skippedIndexes }) => {
              console.info("[TinyFeed restore]", {
                stage: "schema-bootstrap-result",
                elapsedMs: Math.round(performance.now() - bootstrapStarted),
                skippedIndexes: skippedIndexes.length,
              });
              bumpFeedRefresh();
            })
            .catch((e) => {
              console.warn("[TinyFeed restore]", {
                stage: "schema-bootstrap-failed",
                elapsedMs: Math.round(performance.now() - bootstrapStarted),
                message: e instanceof Error ? e.message : String(e),
              });
              if (!cancelled) {
                setRestoreError(e instanceof Error ? e.message : String(e));
              }
            });
          ensureAgentDelegation(restored.appsSpaceUri).catch(() => {});
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
        <p className="feed-status-sub">{restoreStatus}</p>
        {restoreTrace.length > 0 && (
          <details className="restore-trace">
            <summary>Details</summary>
            <ol>
              {restoreTrace.map((trace, index) => (
                <li key={`${trace.stage}-${index}`}>
                  <span>{restoreStageLabel(trace)}</span>
                  <span>{trace.elapsedMs}ms</span>
                </li>
              ))}
            </ol>
          </details>
        )}
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
          ensureDelegation={ensureAgentDelegation}
          onFeedRefresh={bumpFeedRefresh}
          agentError={agentError}
          sessionError={restoreError}
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
          onFeedRefresh={bumpFeedRefresh}
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
