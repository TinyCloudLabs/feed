// Article.tsx — the `/a/:slug` page. Extends the existing FullCard into a
// routed page; the feed is small in v1 so we fetch the page and find the slug
// client-side (no per-artifact server endpoint).

import { useCallback, useEffect, useState } from "react";
import type { FeedCard } from "../types.ts";
import { FullCard, Glyph } from "../Card.tsx";
import { loadFeed } from "../feedClient.ts";
import { Link, navigate } from "../router.tsx";
import type { Session } from "../session.ts";

const PAGE_SIZE = 50;

function BackBar() {
  return (
    <div className="article-bar">
      <Link to={{ kind: "feed" }} className="quiet-link" aria-label="Back to feed">
        <Glyph name="back" size={14} /> Back to feed
      </Link>
    </div>
  );
}

export function ArticlePage({
  slug,
  session,
  onHide,
}: {
  slug: string;
  session: Session;
  onHide: (id: string) => void;
}) {
  const [card, setCard] = useState<FeedCard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hideAndReturn = useCallback(
    (id: string) => {
      onHide(id);
      window.setTimeout(() => navigate({ kind: "feed" }), 600);
    },
    [onHide],
  );

  useEffect(() => {
    let alive = true;
    setCard(null);
    setError(null);
    loadFeed(session.appsSpaceUri, PAGE_SIZE, 0)
      .then((cards) => {
        if (!alive) return;
        const found = cards.find((c) => c.slug === slug);
        if (!found) throw new Error("artifact not found");
        setCard(found);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [slug, session.appsSpaceUri]);

  return (
    <>
      <BackBar />
      {error && (
        <div className="feed-status">
          <p className="feed-status-line">Couldn&rsquo;t open this artifact.</p>
          <p className="feed-status-sub">{error}</p>
        </div>
      )}
      {!card && !error && (
        <>
          <p className="sr-only" role="status">Loading article</p>
          <div className="skel-card" aria-hidden="true" style={{ borderBottom: "none" }}>
            <div className="skel-bar kicker" />
            <div className="skel-bar headline" />
            <div className="skel-bar headline2" />
            <div className="skel-bar body" />
            <div className="skel-bar body2" />
            <div className="skel-bar body3" />
          </div>
        </>
      )}
      {card && (
        <main>
          <FullCard
            card={card}
            appsSpaceUri={session.appsSpaceUri}
            readerDid={session.readerDid}
            onHide={hideAndReturn}
          />
        </main>
      )}
    </>
  );
}
