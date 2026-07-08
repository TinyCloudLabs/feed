import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ControlIntentEvent,
  FeedArtifactProjection,
  FeedbackEvent,
} from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import { DEFAULT_REVIEWED_BUNDLE } from "../../shared/default-reviewed-bundle.ts";
import { FEED_HOST_TOKEN, FEED_HOST_URL } from "./config.ts";
import {
  loadFirstRunApproval,
  saveFirstRunApproval,
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
type BundleState = "idle" | "needs_approval" | "starting" | "running" | "error";

const FEED_EVENTS_RETRY_MS = 5000;
const FEED_HOST_ORIGIN = (() => {
  try {
    return new URL(FEED_HOST_URL).origin;
  } catch {
    return FEED_HOST_URL;
  }
})();

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
  const [bundleState, setBundleState] = useState<BundleState>("idle");
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const feedLoadInFlight = useRef(false);
  const bundleStartInFlight = useRef(false);

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

  const loadFeed = useCallback(async () => {
    if (!session || feedLoadInFlight.current) return;
    feedLoadInFlight.current = true;
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
    } finally {
      feedLoadInFlight.current = false;
    }
  }, [client, session]);

  const resetFeedState = useCallback(() => {
    setBundleState("idle");
    setBundleError(null);
    setItems([]);
    setLoadState("idle");
    setLoadError(null);
    setBusyAction(null);
  }, []);

  const startBundle = useCallback(
    async ({ rememberApproval }: { rememberApproval: boolean }) => {
      if (!session || !policy || bundleStartInFlight.current) return;
      bundleStartInFlight.current = true;
      setBundleState("starting");
      setBundleError(null);
      setLoadError(null);
      try {
        const approval = rememberApproval
          ? await saveFirstRunApproval({
              actorId: session.readerDid,
              hostOrigin: FEED_HOST_ORIGIN,
            })
          : null;
        await submitFeedHostDelegations({ client, policy, actorId: session.readerDid });
        if (approval) {
          try {
            await client.postControlIntent({
              eventId: crypto.randomUUID(),
              actorId: session.readerDid,
              readerNonce: newNonce(),
              intentKind: "enable_package",
              status: "accepted",
              targetRef: DEFAULT_REVIEWED_BUNDLE.packageId,
              payload: {
                approval,
                hostOrigin: FEED_HOST_ORIGIN,
                bundleDigest: DEFAULT_REVIEWED_BUNDLE.digest,
              },
              createdAt: approval.approvedAt,
            });
          } catch (error) {
            // The consent record is durable in TinyCloud KV; the host-side
            // audit intent is best-effort.
            console.warn("Feed Host enable_package control intent was not recorded.", error);
          }
        }
        setBundleState("running");
        await loadFeed();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("fresh wallet-backed delegation")) {
          await signOut();
          setSession(null);
          setSignInError(message);
          resetFeedState();
          return;
        }
        setBundleState("error");
        setBundleError(message);
      } finally {
        bundleStartInFlight.current = false;
      }
    },
    [client, loadFeed, policy, resetFeedState, session],
  );

  useEffect(() => {
    if (!session || !policy) return;
    setBundleError(null);
    setLoadState("idle");
    setLoadError(null);
    let cancelled = false;
    const bootstrapBundle = async () => {
      setBundleState("idle");
      const approval = await loadFirstRunApproval({ actorId: session.readerDid, hostOrigin: FEED_HOST_ORIGIN });
      if (cancelled) return;
      if (approval) {
        void startBundle({ rememberApproval: false });
        return;
      }
      setBundleState("needs_approval");
    };
    void bootstrapBundle();
    return () => {
      cancelled = true;
    };
  }, [policy, session, startBundle]);

  useEffect(() => {
    if (!session || bundleState !== "running") return;
    let cancelled = false;
    let timer: number | undefined;
    let lastSignature = "";

    const pollFeedEvents = async () => {
      if (cancelled) return;
      try {
        const snapshot = await client.getFeedEvents();
        if (cancelled) return;
        // A transient poll failure should clear as soon as the next snapshot succeeds.
        setLoadState((current) => (current === "error" ? "ready" : current));
        setLoadError(null);
        const signature = snapshot.text.trim();
        if (signature !== lastSignature) {
          lastSignature = signature;
          await loadFeed();
        }
      } catch (error) {
        if (!cancelled) {
          setLoadState("error");
          setLoadError(formatHostError(error));
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void pollFeedEvents(), FEED_EVENTS_RETRY_MS);
      }
    };

    void pollFeedEvents();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [bundleState, client, loadFeed, session]);

  const connect = async () => {
    setSignInError(null);
    try {
      const nextPolicy = policy ?? (await client.getDelegationPolicy());
      setPolicy(nextPolicy);
      resetFeedState();
      setSession(await signIn(nextPolicy));
    } catch (error) {
      setSignInError(error instanceof Error ? error.message : String(error));
    }
  };

  const disconnect = async () => {
    await signOut();
    setSession(null);
    resetFeedState();
  };

  const approveAndStartBundle = async () => {
    setBusyAction("approve_bundle");
    try {
      await startBundle({ rememberApproval: true });
    } finally {
      setBusyAction(null);
    }
  };

  const sendFeedback = async (projection: FeedArtifactProjection, signal: FeedbackEvent["signal"]) => {
    if (!session || bundleState !== "running") return;
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
    if (!session || bundleState !== "running") return;
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
        <button className="primary" onClick={() => void connect()}>
          Sign in with OpenKey
        </button>
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
          <button onClick={() => void loadFeed()} disabled={bundleState !== "running"}>
            Refresh
          </button>
          <button onClick={() => void sendAskFeed()} disabled={bundleState !== "running" || busyAction === "ask_feed"}>
            Ask Feed
          </button>
          <button onClick={() => void disconnect()}>Sign out</button>
        </div>
      </header>

      <main className="content-shell">
        {bundleState === "idle" && (
          <NoticePanel
            tone="info"
            title="Checking bundle approval"
            detail="Verifying whether the default reviewed bundle is already approved for this session."
          />
        )}

        {bundleState === "needs_approval" && (
          <FirstRunApprovalPanel
            bundle={DEFAULT_REVIEWED_BUNDLE}
            busy={busyAction === "approve_bundle"}
            error={bundleError}
            onApprove={() => void approveAndStartBundle()}
          />
        )}

        {bundleState === "starting" && (
          <NoticePanel
            tone="info"
            title="Starting the default bundle"
            detail="Feed is installing the reviewed bundle and waiting for the first stub artifact to project."
          />
        )}

        {bundleState === "error" && (
          <BundleFailurePanel
            error={bundleError ?? "The default bundle could not be approved or started."}
            onRetry={() => void startBundle({ rememberApproval: true })}
          />
        )}

        {bundleState === "running" && loadState === "loading" && (
          <NoticePanel
            tone="info"
            title="Loading Feed Host projections"
            detail="Waiting for the reviewed bundle to publish its first artifact."
          />
        )}

        {bundleState === "running" && loadState === "error" && (
          <FeedFailurePanel error={loadError ?? "The feed could not be loaded."} onRetry={() => void loadFeed()} />
        )}

        {bundleState === "running" && loadState !== "error" && items.length === 0 && (
          <EmptyFeedPanel onRetry={() => void loadFeed()} />
        )}

        {bundleState === "running" && (
          <div className="feed-list">
            {items.map((item) => (
              <FeedCard key={item.projection.artifactId} item={item} busyAction={busyAction} onFeedback={sendFeedback} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function FirstRunApprovalPanel({
  bundle,
  busy,
  error,
  onApprove,
}: {
  bundle: typeof DEFAULT_REVIEWED_BUNDLE;
  busy: boolean;
  error: string | null;
  onApprove: () => void;
}) {
  return (
    <section className="panel approval-panel" aria-labelledby="first-run-approval-title">
      <div className="panel-copy">
        <p className="panel-kicker">First run</p>
        <h2 id="first-run-approval-title">Approve the default bundle before Feed starts.</h2>
        <p>{bundle.disclosure.userCopy}</p>
        <p>
          Approval is stored in your TinyCloud space for {FEED_HOST_ORIGIN} and this bundle digest, not in browser
          storage. If the host origin or digest changes, Feed will ask again.
        </p>
      </div>
      <dl className="bundle-details">
        <div>
          <dt>Package</dt>
          <dd>{bundle.displayName}</dd>
        </div>
        <div>
          <dt>Bundle digest</dt>
          <dd>{bundle.digest}</dd>
        </div>
        <div>
          <dt>Feed Host</dt>
          <dd>{FEED_HOST_ORIGIN}</dd>
        </div>
        <div>
          <dt>Artifact type</dt>
          <dd>{bundle.artifactType}</dd>
        </div>
        <div>
          <dt>Runtime class</dt>
          <dd>{bundle.runtime.runtimeClass}</dd>
        </div>
        <div>
          <dt>Runtime provider</dt>
          <dd>{bundle.disclosure.providerClass}</dd>
        </div>
        <div>
          <dt>Credentials</dt>
          <dd>{bundle.disclosure.credentialOwner}</dd>
        </div>
        <div>
          <dt>Egress class</dt>
          <dd>{bundle.disclosure.egressClass}</dd>
        </div>
        <div>
          <dt>Storage</dt>
          <dd>TinyCloud Feed and Artifacts state</dd>
        </div>
        <div>
          <dt>Boundary</dt>
          <dd>No third-party writes or user-world mutation</dd>
        </div>
        <div>
          <dt>Model calls</dt>
          <dd>{bundle.runtime.maxModelCalls}</dd>
        </div>
        <div>
          <dt>Disallowed tools</dt>
          <dd>{bundle.runtime.disallowedTools.join(", ")}</dd>
        </div>
        <div>
          <dt>Source kind</dt>
          <dd>{bundle.sourceRef.sourceKind}</dd>
        </div>
      </dl>
      <div className="panel-actions">
        <button className="primary" onClick={onApprove} disabled={busy}>
          Approve and start
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </section>
  );
}

function NoticePanel({
  tone,
  title,
  detail,
}: {
  tone: "info" | "warning";
  title: string;
  detail: string;
}) {
  return (
    <section className={`panel notice-panel ${tone === "warning" ? "warning-panel" : ""}`} role="status" aria-live="polite">
      <h2>{title}</h2>
      <p>{detail}</p>
    </section>
  );
}

function EmptyFeedPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <section className="panel empty-panel" aria-live="polite">
      <p className="panel-kicker">Bundle running</p>
      <h2>Nothing yet, bundle running.</h2>
      <p>The reviewed bundle is active. The first stub artifact will stream in here without a reload.</p>
      <div className="panel-actions">
        <button onClick={onRetry}>Check again</button>
      </div>
    </section>
  );
}

function FeedFailurePanel({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <section className="panel failure-panel" role="alert">
      <p className="panel-kicker">Feed unavailable</p>
      <h2>Feed failed to load.</h2>
      <p>{error}</p>
      <div className="panel-actions">
        <button className="primary" onClick={onRetry}>
          Retry
        </button>
      </div>
    </section>
  );
}

function BundleFailurePanel({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <section className="panel failure-panel" role="alert">
      <p className="panel-kicker">Bundle start failed</p>
      <h2>We could not approve or start the default bundle.</h2>
      <p>{error}</p>
      <div className="panel-actions">
        <button className="primary" onClick={onRetry}>
          Retry bundle start
        </button>
      </div>
    </section>
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
