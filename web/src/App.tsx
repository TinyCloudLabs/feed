import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  ControlIntentEvent,
  FeedArtifactProjection,
  FeedbackEvent,
} from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import { FEED_HOST_TOKEN, FEED_HOST_URL } from "./config.ts";
import {
  restoreSession,
  signIn,
  signOut,
  submitFeedHostDelegations,
  type FeedSession,
} from "./auth.ts";
import type { FeedHostDelegationPolicy } from "./delegation.ts";
import { FeedV1HostClient, FeedV1HostError } from "./feedV1HostClient.ts";
import { bodyPreview, projectionLabel, sortedFeed, type FeedItem } from "./feedModel.ts";

type LoadState = "idle" | "loading" | "ready" | "error";
type DelegationState = "idle" | "loading" | "ready" | "error";

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function newNonce(): string {
  return crypto.randomUUID();
}

export function App() {
  const [session, setSession] = useState<FeedSession | null>(null);
  const [policy, setPolicy] = useState<FeedHostDelegationPolicy | null>(null);
  const [restoreDone, setRestoreDone] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [delegationState, setDelegationState] = useState<DelegationState>("idle");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const client = useMemo(
    () => new FeedV1HostClient({ baseUrl: FEED_HOST_URL, token: FEED_HOST_TOKEN || undefined, actorId: session?.readerDid }),
    [session?.readerDid],
  );

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const nextPolicy = await client.getDelegationPolicy();
      if (cancelled) return;
      setPolicy(nextPolicy);
      const restored = await restoreSession(nextPolicy);
      if (!cancelled && restored) setSession(restored);
    };
    bootstrap()
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!cancelled) setSignInError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setRestoreDone(true);
      });
    return () => {
      cancelled = true;
      };
  }, []);

  useEffect(() => {
    if (!session || !policy) return;
    let cancelled = false;
    setDelegationState("loading");
    submitFeedHostDelegations({ client, policy, actorId: session.readerDid })
      .then(() => {
        if (!cancelled) setDelegationState("ready");
      })
      .catch(async (error: unknown) => {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("fresh wallet-backed delegation")) {
            await signOut();
            if (cancelled) return;
            setSession(null);
            setSignInError(message);
            setItems([]);
            setDelegationState("idle");
            setLoadState("idle");
            return;
          }
          setDelegationState("error");
          setLoadState("error");
          setLoadError(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, policy, session]);

  const loadFeed = useCallback(async () => {
    if (!session || delegationState !== "ready") return;
    setLoadState("loading");
    setLoadError(null);
    try {
      const page = await client.listFeed({ limit: 40 });
      const hydrated = await Promise.all(
        page.items.map(async (projection): Promise<FeedItem> => {
          try {
            const artifact = await client.getArtifact(projection.artifactId);
            return { projection, artifact };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { projection, artifact: null, error: message };
          }
        }),
      );
      setItems(sortedFeed(hydrated));
      setLoadState("ready");
    } catch (error) {
      setLoadState("error");
      setLoadError(formatHostError(error));
    }
  }, [client, delegationState, session]);

  useEffect(() => {
    void loadFeed();
  }, [loadFeed]);

  const connect = async () => {
    setSignInError(null);
    try {
      const nextPolicy = policy ?? await client.getDelegationPolicy();
      setPolicy(nextPolicy);
      setSession(await signIn(nextPolicy));
    } catch (error) {
      setSignInError(error instanceof Error ? error.message : String(error));
    }
  };

  const disconnect = async () => {
    await signOut();
    setSession(null);
    setDelegationState("idle");
    setItems([]);
    setLoadState("idle");
  };

  const sendFeedback = async (projection: FeedArtifactProjection, signal: FeedbackEvent["signal"]) => {
    if (!session) return;
    const actionId = `${projection.artifactId}:${signal}`;
    setBusyAction(actionId);
    try {
      await client.postFeedback({
        eventId: crypto.randomUUID(),
        artifactId: projection.artifactId,
        actorId: session.readerDid,
        readerNonce: newNonce(),
        signal,
        createdAt: new Date().toISOString(),
      });
      await loadFeed();
    } finally {
      setBusyAction(null);
    }
  };

  const sendAskFeed = async () => {
    if (!session) return;
    const event: ControlIntentEvent = {
      eventId: crypto.randomUUID(),
      actorId: session.readerDid,
      readerNonce: newNonce(),
      intentKind: "ask_feed",
      status: "accepted",
      targetRef: "feed",
      payload: { prompt: "Generate something useful from my latest Listen context." },
      createdAt: new Date().toISOString(),
    };
    setBusyAction("ask_feed");
    try {
      await client.postControlIntent(event);
    } finally {
      setBusyAction(null);
    }
  };

  if (!restoreDone) {
    return <StatusScreen title="Restoring session" detail="Checking Feed Host policy and saved TinyCloud session." />;
  }

  if (!session) {
    return (
      <StatusScreen title="TinyFeed" detail="Private Feed Host client for Feed v1.">
        <button className="primary" onClick={() => void connect()}>Sign in with OpenKey</button>
        {signInError && <p className="error">{signInError}</p>}
      </StatusScreen>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>Feed</h1>
          <p>{FEED_HOST_URL}</p>
        </div>
        <div className="topbar-actions">
          <span className="identity">{shortAddress(session.address)}</span>
          <button onClick={() => void loadFeed()}>Refresh</button>
          <button onClick={() => void sendAskFeed()} disabled={busyAction === "ask_feed"}>Ask Feed</button>
          <button onClick={() => void disconnect()}>Sign out</button>
        </div>
      </header>

      {loadState === "loading" && <div className="notice">Loading Feed Host projections...</div>}
      {delegationState === "loading" && <div className="notice">Creating Feed Host delegation...</div>}
      {loadState === "error" && (
        <div className="notice error">
          <strong>Feed Host unavailable.</strong>
          <span>{loadError}</span>
        </div>
      )}
      {loadState === "ready" && items.length === 0 && (
        <div className="empty">
          <h2>No projected artifacts</h2>
          <p>The Feed Host returned an empty projection set. Generate or enable a package to populate the feed.</p>
        </div>
      )}

      <main className="feed-list">
        {items.map((item) => (
          <FeedCard
            key={item.projection.artifactId}
            item={item}
            busyAction={busyAction}
            onFeedback={sendFeedback}
          />
        ))}
      </main>
    </div>
  );
}

function FeedCard({
  item,
  busyAction,
  onFeedback,
}: {
  item: FeedItem;
  busyAction: string | null;
  onFeedback: (projection: FeedArtifactProjection, signal: FeedbackEvent["signal"]) => Promise<void>;
}) {
  const artifact = item.artifact;
  return (
    <article className={item.projection.disposition === "hidden" ? "feed-card hidden-card" : "feed-card"}>
      <div className="card-meta">
        <span>{artifact?.artifactType ?? "artifact"}</span>
        <span>{projectionLabel(item.projection)}</span>
      </div>
      <h2>{artifact?.title ?? item.projection.artifactId}</h2>
      {artifact?.summary && <p className="summary">{artifact.summary}</p>}
      <pre>{bodyPreview(artifact)}</pre>
      {item.error && <p className="error">Hydration failed: {item.error}</p>}
      <dl className="provenance">
        <div>
          <dt>Package</dt>
          <dd>{artifact?.producedBy.packageId ?? item.projection.packageId}</dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd>{artifact?.freshness.label ?? item.projection.freshnessLabel}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{item.projection.sourceFingerprint}</dd>
        </div>
      </dl>
      <div className="card-actions">
        {(["save", "hide", "helpful", "unhelpful", "show_fewer"] as const).map((signal) => (
          <button
            key={signal}
            disabled={busyAction === `${item.projection.artifactId}:${signal}`}
            onClick={() => void onFeedback(item.projection, signal)}
          >
            {signal.replace("_", " ")}
          </button>
        ))}
      </div>
    </article>
  );
}

function StatusScreen({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <main className="status-screen">
      <h1>{title}</h1>
      <p>{detail}</p>
      {children}
    </main>
  );
}

function formatHostError(error: unknown): string {
  if (error instanceof FeedV1HostError) return `${error.status}: ${error.body || error.message}`;
  return error instanceof Error ? error.message : String(error);
}
