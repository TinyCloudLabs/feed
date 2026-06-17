// Feed.tsx — the `/feed` page. Reuses the existing Card + interaction flow.
// Empty state (no artifacts) points the user at /agents to connect + Generate.
//
// Two agent-build affordances live here (spec §2, §4):
//   • A transient "Get updates" pill that appears once the feed has loaded and
//     auto-disappears 5s later. Clicking it triggers a generate run via the shared
//     useAgentBuild controller (ensure delegation → start → poll → refresh).
//   • An "🛠 Building your feed…" indicator that shows whenever a build is in
//     flight — including one started in ANOTHER tab/session, detected on mount by
//     the controller's getActiveRun() check. While building, the pill is hidden.

import { useCallback, useEffect, useState } from "react";
import type { FeedCard } from "../types.ts";
import { Card } from "../Card.tsx";
import { loadFeed } from "../feedClient.ts";
import { agentConfigured } from "../agentClient.ts";
import { useAgentBuild } from "../useAgentBuild.ts";
import { Shell } from "../Nav.tsx";
import { Link } from "../router.tsx";
import type { Session } from "../session.ts";

const PAGE_SIZE = 50;

/** How long the transient "Get updates" pill lingers after the feed loads before
 *  it quietly fades out (spec §2). */
const GET_UPDATES_VISIBLE_MS = 5000;

function Skeleton() {
  return (
    <div aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="skel-card">
          <div className="skel-bar kicker" />
          <div className="skel-bar headline" />
          <div className="skel-bar headline2" />
          <div className="skel-bar body" />
          <div className="skel-bar body2" />
          <div className="skel-bar body3" />
        </div>
      ))}
    </div>
  );
}

function edition(cards: FeedCard[]): string {
  const newest = cards[0]?.published_at;
  if (!newest) return "";
  const d = new Date(newest);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `Edition ${mm}.${dd} — `;
}

export function FeedPage({
  session,
  hidden,
  onHide,
  onSignOut,
  refreshKey,
  ensureDelegation,
  onFeedRefresh,
  agentError,
}: {
  session: Session;
  hidden: ReadonlySet<string>;
  onHide: (id: string) => void;
  onSignOut: () => void;
  /** Bumped after an agent run so the feed re-reads the user's space. */
  refreshKey: number;
  /** App's auto-connect helper, passed to the build controller (Get updates). */
  ensureDelegation: () => Promise<void>;
  /** Bump the feed refresh key once a build finishes (drives `refreshKey`). */
  onFeedRefresh: () => void;
  /** A background auto-delegation failure surfaced from App. Sign-in now lands
   *  here directly, so without this a silent failure would be invisible until the
   *  user opened Agents / clicked Generate. Rendered as a non-blocking notice. */
  agentError?: string | null;
}) {
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  // Drives the transient "Get updates" pill: shown once the feed has loaded, then
  // auto-hidden after GET_UPDATES_VISIBLE_MS, and immediately on click/build.
  const [showGetUpdates, setShowGetUpdates] = useState(false);

  // Shared build controller: on mount it resumes any in-flight build (this/other
  // tab) and exposes start() for the Get-updates click. Feed has no run history,
  // so it omits the onRunStarted/onRunUpdate callbacks.
  const build = useAgentBuild({ ensureDelegation, onFeedRefresh });
  const emptyDone =
    !build.building &&
    build.live?.status === "done" &&
    (build.live.published?.length ?? 0) === 0 &&
    !build.error;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCards(await loadFeed(session.appsSpaceUri, PAGE_SIZE, 0));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [session.appsSpaceUri]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  // "Get updates" lifecycle (spec §2): once the feed finishes loading, reveal the
  // pill and start a 5s timer to fade it out. We only show it when the agent is
  // configured and no build is already in flight (a build owns the screen via the
  // building indicator instead). Re-arms on each fresh load (refreshKey change).
  useEffect(() => {
    if (loading || !agentConfigured() || build.building) {
      setShowGetUpdates(false);
      return;
    }
    setShowGetUpdates(true);
    const id = window.setTimeout(() => setShowGetUpdates(false), GET_UPDATES_VISIBLE_MS);
    return () => window.clearTimeout(id);
  }, [loading, build.building, refreshKey]);

  // Click the pill → hide it immediately (the building indicator takes over) and
  // kick off the build. start() ensures a delegation, POSTs the run (or attaches
  // to an active one), polls to completion, and refreshes the feed when done.
  const onGetUpdates = useCallback(() => {
    setShowGetUpdates(false);
    void build.start();
  }, [build]);

  const visible = cards.filter(
    (c) => !hidden.has(c.id) && (!activeTag || c.tags.includes(activeTag)),
  );

  const sub = (
    <>
      {edition(cards)}
      {visible.length} artifact{visible.length === 1 ? "" : "s"}
    </>
  );

  const actions = (
    <>
      <button type="button" className="quiet-link" disabled={loading} onClick={() => void refresh()}>
        {loading ? "Loading…" : "Refresh"}
      </button>
      <button type="button" className="quiet-link" onClick={onSignOut}>
        Sign out
      </button>
    </>
  );

  return (
    <Shell title="Feed" sub={sub} actions={actions}>
      {activeTag && (
        <button
          type="button"
          className="mono-chip"
          onClick={() => setActiveTag(null)}
          aria-label={`Clear tag filter ${activeTag}`}
        >
          tag: {activeTag} ✕
        </button>
      )}

      {error && <div className="feed-error">{error}</div>}
      {build.error && <div className="feed-error">{build.error}</div>}
      {emptyDone && (
        <div className="feed-notice" role="status">
          Finished, but no artifacts were published. Add transcripts to Listen, then generate again.
        </div>
      )}
      {/* Background auto-delegation failure (spec audit §4): non-blocking — the
          feed still reads fine; only Generate needs the delegation. Surface it
          here so a silent failure isn't invisible after sign-in lands on /feed,
          and point the user at Agents to retry (Re-grant). */}
      {agentError && (
        <div className="feed-notice" role="status">
          Agent didn’t connect: {agentError}{" "}
          <Link to={{ kind: "agents" }} className="quiet-link" aria-label="Retry on agents page">
            Retry on Agents
          </Link>
        </div>
      )}

      {/* In-progress build indicator (spec §4): shown whenever a build is live —
          including one started in another tab/session (detected on mount). */}
      {build.building && (
        <div className="build-indicator" role="status" aria-live="polite">
          <span className="gen-spinner" aria-hidden="true" />
          <span className="build-indicator-text">
            🛠 Building your feed…
            {build.live ? ` · ${build.live.run_id} · ${build.live.status}` : ""}
          </span>
        </div>
      )}

      <main className="feed">
        {loading ? (
          <>
            <p className="sr-only" role="status">Loading feed</p>
            <Skeleton />
          </>
        ) : visible.length === 0 ? (
          <div className="feed-status">
            <p className="feed-status-line">
              {activeTag ? "Nothing for this tag." : "Nothing yet."}
            </p>
            <p className="feed-status-sub">
              {activeTag
                ? "Clear the filter to see everything"
                : "Connect an agent and Generate to fill your feed"}
            </p>
            {!activeTag && (
              <Link to={{ kind: "agents" }} className="quiet-link" aria-label="Go to agents">
                Connect an agent
              </Link>
            )}
          </div>
        ) : (
          visible.map((c) => (
            <Card
              key={c.id}
              card={c}
              appsSpaceUri={session.appsSpaceUri}
              readerDid={session.readerDid}
              activeTag={activeTag}
              onTagFilter={setActiveTag}
              onHide={onHide}
            />
          ))
        )}
      </main>

      {/* Transient "Get updates" pill (spec §2): bottom-center, unobtrusive,
          auto-fades 5s after the feed loads. Hidden while a build is in flight
          (the indicator above takes over) and when the agent isn't configured. */}
      {showGetUpdates && (
        <button
          type="button"
          className="get-updates-pill"
          onClick={onGetUpdates}
          aria-label="Get updates — generate a fresh feed"
        >
          Get updates
        </button>
      )}
    </Shell>
  );
}
