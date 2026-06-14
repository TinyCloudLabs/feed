import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedCard } from "./types.ts";
import { Card, FullCard, Glyph } from "./Card.tsx";
import { loadFeed } from "./feedClient.ts";
import { signIn, signOut } from "./tinycloud.ts";

const PAGE_SIZE = 50;
const UNDO_MS = 8000;

/** Active owner session: the applications-space URI scopes every read/write. */
interface Session {
  appsSpaceUri: string;
  readerDid: string;
}

type Route =
  | { kind: "feed" }
  | { kind: "article"; slug: string };

function parseRoute(hash: string): Route {
  const m = /^#\/a\/([^/]+)$/.exec(hash);
  if (m) return { kind: "article", slug: decodeURIComponent(m[1]!) };
  return { kind: "feed" };
}

function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<Session | null>(null);
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

  if (!session) return <SignInView onSession={setSession} />;

  return (
    <>
      {route.kind === "article" ? (
        <ArticleView slug={route.slug} session={session} onHide={hideCard} />
      ) : (
        <Feed
          session={session}
          hidden={hidden}
          onHide={hideCard}
          onSignOut={() => {
            void signOut();
            setSession(null);
          }}
        />
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

function SignInView({ onSession }: { onSession: (s: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await signIn();
      onSession(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <header className="masthead">
        <div>
          <h1 className="masthead-title">Feed</h1>
          <p className="masthead-sub">xyz.tinycloud.artifacts</p>
        </div>
      </header>
      <div className="feed-status">
        <p className="feed-status-line">Sign in to read the feed.</p>
        <p className="feed-status-sub">Owner session · applications space</p>
        <button type="button" className="quiet-link" disabled={busy} onClick={() => void go()}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error && <div className="feed-error" style={{ marginTop: 14 }}>{error}</div>}
      </div>
    </>
  );
}

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

function Feed({
  session,
  hidden,
  onHide,
  onSignOut,
}: {
  session: Session;
  hidden: ReadonlySet<string>;
  onHide: (id: string) => void;
  onSignOut: () => void;
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
  }, [refresh]);

  const visible = cards.filter(
    (c) => !hidden.has(c.id) && (!activeTag || c.tags.includes(activeTag)),
  );

  return (
    <>
      <header className="masthead">
        <div>
          <h1 className="masthead-title">Feed</h1>
          <p className="masthead-sub">
            {edition(cards)}
            {visible.length} artifact{visible.length === 1 ? "" : "s"}
          </p>
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
        </div>
        <nav className="masthead-nav" aria-label="Feed controls">
          <button type="button" className="quiet-link" disabled={loading} onClick={() => void refresh()}>
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button type="button" className="quiet-link" onClick={onSignOut}>
            Sign out
          </button>
        </nav>
      </header>

      {error && <div className="feed-error">{error}</div>}

      <main className="feed">
        {loading ? (
          <>
            <p className="sr-only" role="status">Loading feed</p>
            <Skeleton />
          </>
        ) : visible.length === 0 ? (
          <div className="feed-status">
            <p className="feed-status-line">Nothing here yet.</p>
            <p className="feed-status-sub">
              {activeTag ? "No artifacts for this tag" : "Publish artifacts to populate the feed"}
            </p>
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
    </>
  );
}

function BackBar() {
  return (
    <div className="article-bar">
      <a className="quiet-link" href="#/">
        <Glyph name="back" size={14} /> Back to feed
      </a>
    </div>
  );
}

function ArticleView({
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
      window.setTimeout(() => {
        location.hash = "#/";
      }, 600);
    },
    [onHide],
  );

  useEffect(() => {
    let alive = true;
    setCard(null);
    setError(null);
    // The feed is small in v1; fetch the page and find the slug client-side
    // (no per-artifact server endpoint exists — this is pure-client).
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
