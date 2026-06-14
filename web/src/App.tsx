import { useCallback, useRef, useState } from "react";
import { signOut } from "./tinycloud.ts";
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
    setSession(null);
    setDelegation(null);
    setRuns([]);
    navigate({ kind: "connect" });
  }, []);

  // Every route except Connect requires a session. Send unauthenticated deep
  // links back to Connect rather than rendering a page with no session.
  const needsSession = route.kind !== "connect";
  if (needsSession && !session) {
    return (
      <ConnectPage
        session={session}
        delegation={delegation}
        onSession={setSession}
        onDelegation={setDelegation}
      />
    );
  }

  return (
    <>
      {route.kind === "connect" && (
        <ConnectPage
          session={session}
          delegation={delegation}
          onSession={setSession}
          onDelegation={setDelegation}
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
          onDelegation={setDelegation}
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
