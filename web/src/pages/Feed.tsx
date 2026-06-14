// Feed.tsx — the `/feed` page. Reuses the existing Card + interaction flow.
// Empty state (no artifacts) points the user at /agents to connect + Generate.

import { useCallback, useEffect, useState } from "react";
import type { FeedCard } from "../types.ts";
import { Card } from "../Card.tsx";
import { loadFeed } from "../feedClient.ts";
import { Shell } from "../Nav.tsx";
import { Link } from "../router.tsx";
import type { Session } from "../session.ts";

const PAGE_SIZE = 50;

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
}: {
  session: Session;
  hidden: ReadonlySet<string>;
  onHide: (id: string) => void;
  onSignOut: () => void;
  /** Bumped after an agent run so the feed re-reads the user's space. */
  refreshKey: number;
}) {
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);

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
    </Shell>
  );
}
