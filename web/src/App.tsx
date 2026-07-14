import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ControlIntentEvent,
  FeedbackEvent,
} from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import { artifactExpansionSection, type FeedItemProjection } from "../../shared/feed-item.ts";
import { ArtifactBody } from "./ArtifactBody.tsx";
import { FEED_HOST_TOKEN, FEED_HOST_URL } from "./config.ts";
import {
  attachReceivedInputAuthority,
  restoreSession,
  signIn,
  signOut,
  submitFeedHostDelegations,
  type FeedSession,
} from "./auth.ts";
import { isFeedReconnectRequiredError } from "./authPolicy.ts";
import { errorDetail, reportClientEvent } from "./clientLog.ts";
import type { FeedHostDelegationPolicy } from "./delegation.ts";
import {
  FeedV1HostClient,
  FeedV1HostError,
  type FeedHostInputAuthority,
  type FeedHostSkillState,
  type FeedHostWorkflowState,
} from "./feedV1HostClient.ts";
import {
  createLazyArtifactCache,
  feedItemAvailability,
  feedItemsForView,
  feedItemsFromProjections,
  projectedPost,
  readableFeedTime,
  readablePostKind,
  readableProvenance,
  sortedFeed,
  type FeedItem,
  type FeedView,
} from "./feedModel.ts";

type LoadState = "idle" | "loading" | "ready" | "error";
type FeedState = "idle" | "starting" | "running" | "error";
type SetupStage = "identity" | "context" | "preparing";
type RoutineDraft = {
  cadence: "more" | "normal" | "less";
  sourceSelection: "recent_authorized" | "named_sources" | "all_authorized";
  audience: "private" | "team" | "draft";
  outputVolume: "short" | "standard" | "detailed";
};

const FEED_EVENTS_RETRY_MS = 5000;
const RECOVERY_COOLDOWN_MS = 30_000;
const DEFAULT_ROUTINE_DRAFT: RoutineDraft = {
  cadence: "normal",
  sourceSelection: "recent_authorized",
  audience: "private",
  outputVolume: "standard",
};

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
  const [feedState, setFeedState] = useState<FeedState>("idle");
  const [setupStage, setSetupStage] = useState<SetupStage>("identity");
  const [setupError, setSetupError] = useState<string | null>(null);
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeView, setActiveView] = useState<FeedView>("for_you");
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  const feedLoadInFlight = useRef(false);
  const setupInFlight = useRef(false);
  const lastRecoveryAt = useRef(0);
  const feedbackAttempts = useRef(new Map<string, { eventId: string; readerNonce: string }>());

  const client = useMemo(
    () => new FeedV1HostClient({ baseUrl: FEED_HOST_URL, token: FEED_HOST_TOKEN || undefined, actorId: session?.readerDid }),
    [session?.readerDid],
  );
  const artifactCache = useMemo(() => createLazyArtifactCache((artifactId) => client.getArtifact(artifactId)), [client]);

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

  // The host holds delegations in memory; a restart (or expiry) turns every
  // call into 403 insufficient_policy. Delegation minting is silent now, so
  // recover by refetching the policy and re-running setup — no user prompts.
  // Cooldown keeps a genuinely broken delegation from looping forever.
  const recoverDelegation = useCallback(async (): Promise<boolean> => {
    const now = Date.now();
    if (now - lastRecoveryAt.current < RECOVERY_COOLDOWN_MS) return false;
    lastRecoveryAt.current = now;
    reportClientEvent("warn", "delegation_lost_recovering", undefined, session?.readerDid);
    try {
      const nextPolicy = await client.getDelegationPolicy();
      setFeedState("starting");
      setSetupStage("context");
      setPolicy(nextPolicy);
      return true;
    } catch (error) {
      reportClientEvent("error", "delegation_recovery_failed", errorDetail(error), session?.readerDid);
      return false;
    }
  }, [client, session]);

  const loadFeed = useCallback(async () => {
    if (!session || feedLoadInFlight.current) return;
    feedLoadInFlight.current = true;
    setLoadState("loading");
    try {
      const page = await client.listFeed({ limit: 40 });
      setItems((current) => {
        const previous = new Map(current.map((item) => [item.projection.feedItemId, item]));
        return sortedFeed(feedItemsFromProjections(page.items).map((item) => ({
          ...item,
          artifact: artifactCache.peek(item.projection.target.artifactId) ?? previous.get(item.projection.feedItemId)?.artifact ?? null,
        })));
      });
      setLoadError(null);
      setLoadState("ready");
    } catch (error) {
      if (isDelegationLostError(error)) {
        feedLoadInFlight.current = false;
        if (await recoverDelegation()) return;
      }
      reportClientEvent("error", "feed_load_failed", errorDetail(error), session.readerDid);
      setLoadState("error");
      setLoadError(formatHostError(error));
    } finally {
      feedLoadInFlight.current = false;
    }
  }, [artifactCache, client, recoverDelegation, session]);

  const resetFeedState = useCallback(() => {
    setFeedState("idle");
    setSetupStage("identity");
    setSetupError(null);
    setItems([]);
    setLoadState("idle");
    setLoadError(null);
    setEventsError(null);
    setBusyAction(null);
    setCommandStatus(null);
    setMenuOpen(false);
    setSettingsOpen(false);
    setActiveView("for_you");
    artifactCache.clear();
    feedbackAttempts.current.clear();
  }, [artifactCache]);

  const startFeed = useCallback(
    async () => {
      if (!session || !policy || setupInFlight.current) return;
      setupInFlight.current = true;
      setFeedState("starting");
      setSetupStage("context");
      setSetupError(null);
      setLoadError(null);
      try {
        await submitFeedHostDelegations({ client, policy, actorId: session.readerDid });
        setSetupStage("preparing");
        await loadFeed();
        setFeedState("running");
      } catch (error) {
        console.error("[Feed setup]", error);
        if (isFeedReconnectRequiredError(error)) {
          reportClientEvent("warn", "feed_reconnect_required", errorDetail(error), session.readerDid);
          await signOut().catch(() => undefined);
          setSession(null);
          setSignInError(error.message);
          resetFeedState();
          return;
        }
        reportClientEvent("error", "feed_setup_failed", errorDetail(error), session.readerDid);
        setFeedState("error");
        setSetupError("Feed could not finish connecting. Check your connection and try again.");
      } finally {
        setupInFlight.current = false;
      }
    },
    [client, loadFeed, policy, resetFeedState, session],
  );

  useEffect(() => {
    if (!session || !policy) return;
    setSetupError(null);
    setLoadState("idle");
    setLoadError(null);
    setEventsError(null);
    void startFeed();
  }, [policy, session, startFeed]);

  useEffect(() => {
    if (!session || feedState !== "running") return;
    let cancelled = false;
    let timer: number | undefined;
    let lastSignature = "";

    const pollFeedEvents = async () => {
      if (cancelled) return;
      try {
        const snapshot = await client.getFeedEvents();
        if (cancelled) return;
        setEventsError(null);
        const signature = snapshot.text.trim();
        if (signature !== lastSignature) {
          lastSignature = signature;
          await loadFeed();
        }
      } catch (error) {
        if (!cancelled) {
          if (isDelegationLostError(error) && (await recoverDelegation())) {
            // Setup restarts; feedState leaves "running" and this loop unwinds.
            return;
          }
          setEventsError(formatHostError(error));
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
  }, [client, feedState, loadFeed, recoverDelegation, session]);

  const connect = async () => {
    setSignInError(null);
    try {
      const nextPolicy = policy ?? (await client.getDelegationPolicy());
      setPolicy(nextPolicy);
      resetFeedState();
      setSession(await signIn(nextPolicy));
    } catch (error) {
      reportClientEvent("error", "sign_in_failed", errorDetail(error));
      setSignInError(error instanceof Error ? error.message : String(error));
    }
  };

  const disconnect = async () => {
    try {
      await client.disconnectFeed();
    } catch {
      // Local sign-out still completes if the Host is already unavailable or disconnected.
    } finally {
      await signOut().catch(() => undefined);
      setSession(null);
      resetFeedState();
    }
  };

  const hydrateArtifact = useCallback(async (projection: FeedItemProjection): Promise<void> => {
    const hydrated = await artifactCache.hydrate({ projection, artifact: null });
    setItems((current) => current.map((item) => item.projection.target.artifactId === projection.target.artifactId
      ? { ...item, artifact: hydrated.artifact, error: hydrated.error ? "This artifact is temporarily unavailable." : undefined }
      : item));
  }, [artifactCache]);

  const sendFeedback = async (
    projection: FeedItemProjection,
    signal: FeedbackEvent["signal"],
    payload?: unknown,
    attemptKey = `${projection.feedItemId}:${signal}`,
  ): Promise<boolean> => {
    if (!session || feedState !== "running") return false;
    const actionId = `${projection.feedItemId}:${signal}`;
    let attempt = feedbackAttempts.current.get(attemptKey);
    if (!attempt) {
      attempt = { eventId: crypto.randomUUID(), readerNonce: newNonce() };
      feedbackAttempts.current.set(attemptKey, attempt);
    }
    setBusyAction(actionId);
    try {
      await client.postFeedback({
        eventId: attempt.eventId,
        target: { kind: "feed_item", feedItemId: projection.feedItemId },
        actorId: session.readerDid,
        readerNonce: attempt.readerNonce,
        signal,
        ...(payload === undefined ? {} : { payload }),
        createdAt: new Date().toISOString(),
      });
      feedbackAttempts.current.delete(attemptKey);
      setItems((current) => {
        if (signal === "hide") return current.filter((item) => item.projection.feedItemId !== projection.feedItemId);
        if (signal !== "save" && signal !== "unsave") return current;
        return current.map((item) => item.projection.feedItemId === projection.feedItemId
          ? { ...item, projection: { ...item.projection, disposition: signal === "save" ? "saved" : "default" } }
          : item);
      });
      void loadFeed();
      return true;
    } catch (error) {
      const status = error instanceof FeedV1HostError ? error.status : "unknown";
      reportClientEvent("error", "feed_interaction_failed", `signal=${signal} status=${status}`, session.readerDid);
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const sendAskFeed = async () => {
    if (!session || feedState !== "running") return;
    const event: ControlIntentEvent = {
      eventId: crypto.randomUUID(),
      actorId: session.readerDid,
      readerNonce: newNonce(),
      intentKind: "ask_feed",
      status: "accepted",
      targetRef: "feed",
      payload: { prompt: "Generate something useful from my latest authorized context." },
      createdAt: new Date().toISOString(),
    };
    setBusyAction("ask_feed");
    try {
      await client.postControlIntent(event);
      setCommandStatus("Feed is looking through your latest context.");
    } catch (error) {
      const status = error instanceof FeedV1HostError ? error.status : "unknown";
      reportClientEvent("error", "ask_feed_failed", `status=${status}`, session.readerDid);
      setCommandStatus("Feed could not start that request. Try again.");
    } finally {
      setBusyAction(null);
    }
  };

  const visibleItems = feedItemsForView(items, activeView);
  const visibleLoadError = loadError ?? eventsError;

  if (!restoreDone) {
    return <StatusScreen title="Opening Feed" detail="Checking your saved sign-in." />;
  }

  if (!session) {
    return <SignInScreen error={signInError} onSignIn={() => void connect()} />;
  }

  if (feedState === "idle" || feedState === "starting") {
    return <SetupScreen stage={setupStage} />;
  }

  if (feedState === "error") {
    return (
      <SetupFailurePanel
        error={setupError ?? "Feed could not finish connecting."}
        onRetry={() => void startFeed()}
        onSignInAgain={() => void disconnect()}
      />
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <h1>Feed</h1>
          <p>Private by default</p>
        </div>
        <nav
          className="feed-tabs"
          aria-label="Feed views"
          role="tablist"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const nextView = event.key === "ArrowLeft" || event.key === "Home" ? "for_you" : "saved";
            setActiveView(nextView);
            requestAnimationFrame(() => document.getElementById(`feed-tab-${nextView}`)?.focus());
          }}
        >
          <button
            id="feed-tab-for_you"
            role="tab"
            aria-controls="feed-view-panel"
            aria-selected={activeView === "for_you"}
            tabIndex={activeView === "for_you" ? 0 : -1}
            onClick={() => setActiveView("for_you")}
          >For you</button>
          <button
            id="feed-tab-saved"
            role="tab"
            aria-controls="feed-view-panel"
            aria-selected={activeView === "saved"}
            tabIndex={activeView === "saved" ? 0 : -1}
            onClick={() => setActiveView("saved")}
          >Saved</button>
        </nav>
        <div className="topbar-actions">
          <button className="primary" onClick={() => void sendAskFeed()} disabled={busyAction === "ask_feed"}>
            Ask Feed
          </button>
          <button onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-haspopup="true" aria-controls="feed-menu">
            Menu
          </button>
        </div>
      </header>

      {menuOpen && (
        <nav id="feed-menu" className="menu-panel" aria-label="Feed menu">
          <span className="identity">Signed in as {shortAddress(session.address)}</span>
          <button onClick={() => void loadFeed()}>Refresh</button>
          <button onClick={() => {
            setSettingsOpen((open) => !open);
            setMenuOpen(false);
          }} aria-expanded={settingsOpen}>
            {settingsOpen ? "Close access settings" : "Access & automation"}
          </button>
          <button onClick={() => void disconnect()}>Sign out</button>
        </nav>
      )}

      {settingsOpen && (
        <SkillCredentialsPanel client={client} policy={policy!} actorId={session.readerDid} onDisconnect={() => void disconnect()} />
      )}

      <main
        id="feed-view-panel"
        className="content-shell"
        role="tabpanel"
        aria-labelledby={`feed-tab-${activeView}`}
      >
        {commandStatus && <p className="interaction-status" role="status" aria-live="polite">{commandStatus}</p>}
        {loadState === "loading" && visibleLoadError === null && (
          <NoticePanel
            tone="info"
            title="Refreshing your Feed"
            detail="Checking for useful items from your recent context."
          />
        )}

        {visibleLoadError !== null && (
          <FeedFailurePanel error={visibleLoadError} onRetry={() => void loadFeed()} />
        )}

        {loadState === "ready" && visibleLoadError === null && visibleItems.length === 0 && (
          activeView === "saved"
            ? <EmptySavedPanel onShowFeed={() => setActiveView("for_you")} />
            : <EmptyFeedPanel onRetry={() => void loadFeed()} />
        )}

        <div className="feed-list">
          {visibleItems.map((item) => (
            <FeedCard
              key={item.projection.feedItemId}
              item={item}
              busyAction={busyAction}
              onExpand={hydrateArtifact}
              onFeedback={sendFeedback}
              onResetAttempt={(attemptKey) => feedbackAttempts.current.delete(attemptKey)}
            />
          ))}
        </div>
      </main>
    </div>
  );
}

function SignInScreen({ error, onSignIn }: { error: string | null; onSignIn: () => void }) {
  return (
    <main className="signin-screen">
      <header className="signin-header">
        <strong>Feed</strong>
        <span>Private by default</span>
      </header>
      <section className="signin-copy" aria-labelledby="signin-title">
        <h1 id="signin-title">Your private context, made useful.</h1>
        <p>Read, ask, and shape a Feed grounded in the conversations you choose.</p>
        {error && <p className="reconnect-message" role="alert">{error}</p>}
        <button className="primary signin-action" onClick={onSignIn}>Sign in with OpenKey</button>
      </section>
      <section className="signin-access" aria-labelledby="signin-access-title">
        <h2 id="signin-access-title">One sign-in connects</h2>
        <ul>
          <li>The context you choose</li>
          <li>Your private Feed storage</li>
          <li>Feed’s content-making service</li>
        </ul>
        <p>Review, pause, or disconnect access anytime.</p>
      </section>
    </main>
  );
}

function SetupScreen({ stage }: { stage: SetupStage }) {
  const contextReady = stage === "preparing";
  return (
    <main className="setup-screen" aria-labelledby="setup-title">
      <header className="setup-header"><strong>Feed</strong></header>
      <section className="setup-copy" role="status" aria-live="polite">
        <h1 id="setup-title">Setting up your Feed</h1>
        <p>No additional approvals are needed.</p>
        <ol className="setup-progress">
          <li className="complete">
            <span className="progress-mark" aria-hidden="true">✓</span>
            <span><strong>TinyCloud connected</strong><small>Identity and storage are ready.</small></span>
          </li>
          <li className={contextReady ? "complete" : "current"}>
            <span className="progress-mark" aria-hidden="true">{contextReady ? "✓" : ""}</span>
            <span><strong>Context connected</strong><small>Allowed sources are readable.</small></span>
          </li>
          <li className={contextReady ? "current" : "pending"}>
            <span className="progress-mark" aria-hidden="true" />
            <span><strong>Preparing your first Feed</strong><small>Making useful items now.</small></span>
          </li>
        </ol>
        <p className="setup-help">If anything needs attention, Feed will say what to reconnect.</p>
      </section>
    </main>
  );
}

function SetupFailurePanel({
  error,
  onRetry,
  onSignInAgain,
}: {
  error: string;
  onRetry: () => void;
  onSignInAgain: () => void;
}) {
  return (
    <main className="status-screen" role="alert">
      <p className="status-label">Feed needs attention</p>
      <h1>We couldn’t finish setting up your Feed.</h1>
      <p>{error}</p>
      <div className="panel-actions">
        <button className="primary" onClick={onRetry}>Try again</button>
        <button onClick={onSignInAgain}>Sign in again</button>
      </div>
    </main>
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
      <p className="panel-kicker">Feed is ready</p>
      <h2>Nothing here yet.</h2>
      <p>Feed is looking through the context you allowed. Useful items will appear here as they’re ready.</p>
      <div className="panel-actions">
        <button onClick={onRetry}>Check again</button>
      </div>
    </section>
  );
}

function EmptySavedPanel({ onShowFeed }: { onShowFeed: () => void }) {
  return (
    <section className="panel empty-panel" aria-live="polite">
      <h2>No saved posts yet.</h2>
      <p>Save anything you want to return to. It will stay here without changing your main Feed.</p>
      <div className="panel-actions">
        <button onClick={onShowFeed}>Browse your Feed</button>
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

function FeedCard({
  item,
  busyAction,
  onExpand,
  onFeedback,
  onResetAttempt,
}: {
  item: FeedItem;
  busyAction: string | null;
  onExpand: (projection: FeedItemProjection) => Promise<void>;
  onFeedback: (
    projection: FeedItemProjection,
    signal: FeedbackEvent["signal"],
    payload?: unknown,
    attemptKey?: string,
  ) => Promise<boolean>;
  onResetAttempt: (attemptKey: string) => void;
}) {
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [noteAttemptKey, setNoteAttemptKey] = useState(() => crypto.randomUUID());
  const [interactionStatus, setInteractionStatus] = useState<string | null>(null);
  const artifact = item.artifact;
  const post = projectedPost(item);
  const provenance = readableProvenance(item);
  const availability = feedItemAvailability(item);
  const isSaved = item.projection.disposition === "saved";
  const isPost = item.projection.target.kind === "post" || Boolean(item.projection.postBody);
  const title = item.projection.postTitle ?? post?.title ?? artifact?.title;
  const expansionSection = artifact ? artifactExpansionSection(artifact, item.projection.sectionRef) : undefined;
  const loadArtifact = async () => {
    if (artifact || artifactLoading) return;
    setArtifactLoading(true);
    await onExpand(item.projection);
    setArtifactLoading(false);
  };
  const act = async (signal: FeedbackEvent["signal"]) => {
    setInteractionStatus(null);
    const ok = await onFeedback(item.projection, signal);
    setInteractionStatus(ok ? feedbackSuccessLabel(signal) : "That change did not go through. Try again.");
  };
  return (
    <article className="feed-card">
      <div className="card-meta">
        <span>{readablePostKind(item)}</span>
        <span>{readableFeedTime(item.projection.publishedAt)}</span>
      </div>
      {title && <h2>{title}</h2>}
      {availability !== "available" && <p className="availability-message">{availabilityMessage(availability, Boolean(artifact))}</p>}
      {isPost ? (
        <>
          <p className="post-body">{item.projection.postBody ?? post?.body ?? "Open the artifact to read this post in context."}</p>
          <details
            className="artifact-expansion"
            onToggle={(event) => event.currentTarget.open && void loadArtifact()}
          >
            <summary>Open complete artifact</summary>
            <div className="artifact-content">
              {artifactLoading && <p role="status" aria-live="polite">Loading the complete artifact…</p>}
              {item.error && <p className="availability-message">{item.error} You can retry by closing and opening this section.</p>}
              {artifact && <p className="artifact-label">From {artifact.title}</p>}
              {artifact?.summary && <p className="summary">{artifact.summary}</p>}
              {artifact && <ArtifactBody body={artifact.body} targetSection={expansionSection} />}
            </div>
          </details>
        </>
      ) : (
        <details className="artifact-expansion" onToggle={(event) => event.currentTarget.open && void loadArtifact()}>
          <summary>Open artifact</summary>
          <div className="artifact-content">
            {artifactLoading && <p role="status" aria-live="polite">Loading the artifact…</p>}
            {item.error && <p className="availability-message">{item.error}</p>}
            {artifact?.summary && <p className="summary">{artifact.summary}</p>}
            {artifact && <ArtifactBody body={artifact.body} targetSection={expansionSection} />}
          </div>
        </details>
      )}
      <details className="why-this" onToggle={(event) => event.currentTarget.open && void loadArtifact()}>
        <summary>Why this?</summary>
        <dl className="provenance">
          <div><dt>Made by</dt><dd>{provenance.madeBy}</dd></div>
          <div><dt>Sources</dt><dd>{provenance.sourceSummary}</dd></div>
          <div><dt>Freshness</dt><dd>{provenance.freshnessSummary}</dd></div>
          {post && <div><dt>Evidence</dt><dd>{post.evidence.length} linked item{post.evidence.length === 1 ? "" : "s"}</dd></div>}
        </dl>
        {provenance.workflowSummary && <p>{provenance.workflowSummary}</p>}
        <details className="advanced-details">
          <summary>Advanced details for debugging</summary>
          <code>Feed item: {item.projection.feedItemId}</code>
          <code>Artifact: {item.projection.target.artifactId}</code>
          <code>Source fingerprint: {item.projection.sourceFingerprint}</code>
        </details>
      </details>
      <div className="card-actions">
        <div className="card-actions-primary">
          <button
            disabled={busyAction === `${item.projection.feedItemId}:${isSaved ? "unsave" : "save"}`}
            onClick={() => void act(isSaved ? "unsave" : "save")}
          >
            {isSaved ? "Saved" : "Save"}
          </button>
          <button disabled={busyAction === `${item.projection.feedItemId}:helpful`} onClick={() => void act("helpful")}>Helpful</button>
          <button onClick={() => setNoteOpen((open) => !open)} aria-expanded={noteOpen}>Add note</button>
        </div>
        <div className="card-actions-secondary">
          <button disabled={busyAction === `${item.projection.feedItemId}:unhelpful`} onClick={() => void act("unhelpful")}>Not helpful</button>
          <button disabled={busyAction === `${item.projection.feedItemId}:show_fewer`} onClick={() => void act("show_fewer")}>Show fewer like this</button>
          <button disabled={busyAction === `${item.projection.feedItemId}:hide`} onClick={() => void act("hide")}>Hide</button>
        </div>
      </div>
      {noteOpen && (
        <form className="note-form" onSubmit={(event) => {
          event.preventDefault();
          const trimmed = note.trim();
          if (!trimmed) return;
          setInteractionStatus(null);
          void onFeedback(item.projection, "text_note", { note: trimmed }, noteAttemptKey).then((ok) => {
            if (ok) {
              setNote("");
              setNoteOpen(false);
              setNoteAttemptKey(crypto.randomUUID());
              setInteractionStatus("Note saved.");
            } else {
              setInteractionStatus("Your note was not saved. Try again.");
            }
          });
        }}>
          <label htmlFor={`note-${item.projection.feedItemId}`}>Private note</label>
          <textarea
            id={`note-${item.projection.feedItemId}`}
            value={note}
            maxLength={1024}
            onChange={(event) => {
              setNote(event.target.value);
              // Editing creates a new payload; an immediate retry keeps the
              // current key so its event id and reader nonce stay stable.
              onResetAttempt(noteAttemptKey);
              setNoteAttemptKey(crypto.randomUUID());
            }}
          />
          <div className="note-meta"><span>Only you can see this note.</span><span>{note.length}/1024</span></div>
          <div className="panel-actions">
            <button type="submit" className="primary" disabled={!note.trim() || busyAction === `${item.projection.feedItemId}:text_note`}>Save note</button>
            <button type="button" onClick={() => {
              onResetAttempt(noteAttemptKey);
              setNoteAttemptKey(crypto.randomUUID());
              setNoteOpen(false);
              setNote("");
            }}>Cancel</button>
          </div>
        </form>
      )}
      {interactionStatus && (
        <p className={`interaction-status${interactionStatus.includes("not") || interactionStatus.includes("did not") ? " error" : ""}`} role="status" aria-live="polite">
          {interactionStatus}
        </p>
      )}
    </article>
  );
}

function availabilityMessage(availability: ReturnType<typeof feedItemAvailability>, hasArtifact: boolean): string {
  if (availability === "source_revoked") {
    return hasArtifact
      ? "This source is disconnected. You can still read this saved artifact, but Feed cannot refresh it."
      : "This source is disconnected, so Feed cannot refresh this item.";
  }
  if (availability === "source_unavailable") {
    return hasArtifact
      ? "The source is temporarily unavailable. This previously made artifact is still readable."
      : "The source is temporarily unavailable. Try opening this item again later.";
  }
  if (availability === "artifact_unavailable") return "The complete artifact is temporarily unavailable. This post remains readable.";
  return "";
}

function feedbackSuccessLabel(signal: FeedbackEvent["signal"]): string {
  switch (signal) {
    case "save": return "Saved.";
    case "unsave": return "Removed from saved.";
    case "hide": return "Hidden from your Feed.";
    case "helpful": return "Marked helpful.";
    case "unhelpful": return "Thanks. Feed will use that feedback.";
    case "show_fewer": return "Feed will show fewer posts like this.";
    case "unhide": return "Returned to your Feed.";
    case "text_note": return "Note saved.";
  }
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
  if (error instanceof FeedV1HostError) {
    if (error.status === 401 || error.status === 403) return "Your Feed connection needs to be refreshed.";
    if (error.status === 404) return "This item is no longer available.";
    if (error.status === 409) return "This changed elsewhere. Refresh and try again.";
    if (error.status === 424) return "The original source is currently unavailable.";
    if (error.status >= 500) return "Feed is temporarily unavailable. Try again shortly.";
  }
  return "Feed could not complete that request. Check your connection and try again.";
}

// The host reports a missing/stale delegation as 403 insufficient_policy or
// denied, or 409 delegation_stale — all recoverable by re-submitting.
function isDelegationLostError(error: unknown): boolean {
  if (!(error instanceof FeedV1HostError)) return false;
  if (error.status === 401) return error.body.includes("actor session");
  if (error.status === 409) return error.body.includes("delegation_stale");
  if (error.status === 403) return error.body.includes("insufficient_policy") || error.body.includes("denied");
  return false;
}

function routineDraftFromWorkflow(workflow: FeedHostWorkflowState): RoutineDraft {
  return {
    cadence: workflow.cadence ?? DEFAULT_ROUTINE_DRAFT.cadence,
    sourceSelection: workflow.settings?.sourceSelection ?? DEFAULT_ROUTINE_DRAFT.sourceSelection,
    audience: workflow.settings?.audience ?? DEFAULT_ROUTINE_DRAFT.audience,
    outputVolume: workflow.settings?.outputVolume ?? DEFAULT_ROUTINE_DRAFT.outputVolume,
  };
}

function seedRoutineDrafts(
  workflows: FeedHostWorkflowState[],
  current: Record<string, RoutineDraft>,
): Record<string, RoutineDraft> {
  const next: Record<string, RoutineDraft> = {};
  for (const workflow of workflows) {
    next[workflow.packageId] = current[workflow.packageId] ?? routineDraftFromWorkflow(workflow);
  }
  return next;
}

function cadenceLabel(value?: RoutineDraft["cadence"]): string {
  switch (value) {
    case "more": return "As new content arrives";
    case "less": return "On demand";
    case "normal":
    default: return "Daily";
  }
}

function sourceSelectionLabel(value: RoutineDraft["sourceSelection"]): string {
  switch (value) {
    case "named_sources": return "Named sources only";
    case "all_authorized": return "Everything authorized";
    case "recent_authorized":
    default: return "Recent authorized conversations";
  }
}

function audienceLabel(value: RoutineDraft["audience"]): string {
  switch (value) {
    case "team": return "Team-ready draft";
    case "draft": return "Draft only";
    case "private":
    default: return "Private to me";
  }
}

function routineSuccessMessage(intentKind: ControlIntentEvent["intentKind"], displayName: string): string {
  switch (intentKind) {
    case "generate_new_request": return `${displayName} is queued to run.`;
    case "ask_feed": return `${displayName} was sent to Feed.`;
    case "enable_package": return `${displayName} is active.`;
    case "pause_package": return `${displayName} is paused.`;
    case "disable_package": return `${displayName} was removed from your routine list.`;
    case "reset_package": return `${displayName} settings were reset.`;
    case "tune_package": return `${displayName} settings were saved.`;
    default: return `${displayName} was updated.`;
  }
}

function SkillCredentialsPanel({
  client,
  policy,
  actorId,
  onDisconnect,
}: {
  client: FeedV1HostClient;
  policy: FeedHostDelegationPolicy;
  actorId: string;
  onDisconnect: () => void;
}) {
  const [skills, setSkills] = useState<FeedHostSkillState[]>([]);
  const [workflows, setWorkflows] = useState<FeedHostWorkflowState[]>([]);
  const [inputAuthorities, setInputAuthorities] = useState<FeedHostInputAuthority[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inputAuthorityError, setInputAuthorityError] = useState<string | null>(null);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [busyWorkflowId, setBusyWorkflowId] = useState<string | null>(null);
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, { providerId: string; secretRef: string }>>({});
  const [routineDrafts, setRoutineDrafts] = useState<Record<string, RoutineDraft>>({});
  const [routineStatus, setRoutineStatus] = useState<string | null>(null);
  const [newSkill, setNewSkill] = useState({ skillId: "", providerId: "", secretRef: "" });
  const [newSource, setNewSource] = useState({ sourceId: "", displayName: "", tc1Link: "" });

  const reload = useCallback(async () => {
    setLoadState("loading");
    try {
      const [skillsPage, authorityPage, workflowsPage] = await Promise.allSettled([
        client.listSkills({ limit: 50 }),
        client.listInputAuthorities(),
        client.listWorkflows({ limit: 50 }),
      ]);
      if (skillsPage.status === "rejected") throw skillsPage.reason;
      setSkills(skillsPage.value.items);
      if (workflowsPage.status === "rejected") throw workflowsPage.reason;
      setWorkflows(workflowsPage.value.items);
      setRoutineDrafts((current) => seedRoutineDrafts(workflowsPage.value.items, current));
      if (authorityPage.status === "fulfilled") {
        setInputAuthorities(authorityPage.value.items);
        setInputAuthorityError(null);
      } else {
        setInputAuthorities([]);
        setInputAuthorityError(formatHostError(authorityPage.reason));
      }
      setLoadError(null);
      setLoadState("ready");
    } catch (error) {
      setLoadState("error");
      setLoadError(formatHostError(error));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patch = async (
    skillId: string,
    expectedVersion: number,
    mode: "user_byok_api_key" | "none",
    providerId?: string,
    secretRef?: string,
    onSuccess?: () => void,
  ) => {
    setBusySkillId(skillId);
    try {
      const result = await client.patchSkillCredentials(skillId, {
        expectedVersion,
        credentialMode: mode,
        providerId,
        secretRef,
      });
      setSkills((current) => {
        const next = current.filter((skill) => skill.skillId !== result.skill.skillId);
        return [...next, result.skill].sort((left, right) => left.skillId.localeCompare(right.skillId));
      });
      onSuccess?.();
    } catch (error) {
      setLoadError(formatHostError(error));
    } finally {
      setBusySkillId(null);
    }
  };

  const postWorkflowIntent = async (
    workflow: FeedHostWorkflowState,
    intentKind: ControlIntentEvent["intentKind"],
    payload: Record<string, unknown> = {},
  ) => {
    setBusyWorkflowId(workflow.packageId);
    setRoutineStatus(null);
    try {
      await client.postControlIntent({
        eventId: crypto.randomUUID(),
        actorId,
        readerNonce: newNonce(),
        intentKind,
        status: "accepted",
        targetRef: `package:${workflow.packageId}`,
        payload,
        createdAt: new Date().toISOString(),
      });
      setRoutineStatus(routineSuccessMessage(intentKind, workflow.displayName));
      if (intentKind === "reset_package") {
        setRoutineDrafts((state) => {
          const next = { ...state };
          delete next[workflow.packageId];
          return next;
        });
      }
      await reload();
    } catch (error) {
      setLoadError(formatHostError(error));
    } finally {
      setBusyWorkflowId(null);
    }
  };

  return (
    <section className="panel settings-panel" aria-labelledby="skill-credentials-title">
      <div className="panel-copy">
        <p className="panel-kicker">Feed access is healthy</p>
        <h2 id="skill-credentials-title">Access & automation</h2>
        <p>
          Feed can read the Listen context you allowed, make Feed items, and save your item preferences. Advanced
          credential controls are available below when a content type needs its own provider key.
        </p>
      </div>
      <ul className="access-summary" aria-label="What Feed can do">
        <li><strong>Read Listen context</strong><span>Transcripts · read only</span></li>
        <li><strong>Make Feed items</strong><span>Grounded drafts from context</span></li>
        <li><strong>Save Feed state</strong><span>Items and preferences</span></li>
      </ul>
      {loadState === "loading" && <p>Loading skill credential settings.</p>}
      {loadError && <p className="error">{loadError}</p>}
      <div className="settings-subsection">
        <h3>Routines</h3>
        {routineStatus && <p className="interaction-status" role="status" aria-live="polite">{routineStatus}</p>}
        {loadState === "ready" && workflows.length === 0 && (
          <p>No routines are available yet.</p>
        )}
        <ul className="skill-list">
          {workflows.map((workflow) => {
            const draft = routineDrafts[workflow.packageId] ?? routineDraftFromWorkflow(workflow);
            const busy = busyWorkflowId === workflow.packageId;
            return (
              <li key={workflow.packageId} className="skill-row routine-row">
                <div className="skill-summary routine-summary">
                  <strong>{workflow.displayName}</strong>
                  <span>{workflow.disabled ? "Removed" : workflow.paused ? "Paused" : "Active"}</span>
                  <span>{workflow.presentation?.cadenceLabel ?? cadenceLabel(workflow.cadence)}</span>
                  <span>{workflow.presentation?.sourcesLabel ?? sourceSelectionLabel(draft.sourceSelection)}</span>
                  <span>{workflow.presentation?.audienceLabel ?? audienceLabel(draft.audience)}</span>
                </div>
                <p className="routine-purpose">{workflow.presentation?.purpose ?? workflow.disclosure.userCopy}</p>
                {workflow.example && (
                  <span className="routine-example">Latest example: {workflow.example.title ?? workflow.example.artifactId}</span>
                )}
                {workflow.lastRun && (
                  <span className="routine-example">
                    Last run: {workflow.lastRun.status} · {new Date(workflow.lastRun.startedAt).toLocaleString()}
                  </span>
                )}
                <details className="routine-details">
                  <summary>Edit routine</summary>
                  <div className="skill-actions routine-edit-grid">
                    <label>
                      Frequency
                      <select
                        value={draft.cadence}
                        onChange={(event) => setRoutineDrafts((state) => ({
                          ...state,
                          [workflow.packageId]: { ...draft, cadence: event.target.value as RoutineDraft["cadence"] },
                        }))}
                        disabled={busy}
                      >
                        <option value="normal">Daily</option>
                        <option value="more">As new content arrives</option>
                        <option value="less">On demand</option>
                      </select>
                    </label>
                    <label>
                      Sources
                      <select
                        value={draft.sourceSelection}
                        onChange={(event) => setRoutineDrafts((state) => ({
                          ...state,
                          [workflow.packageId]: { ...draft, sourceSelection: event.target.value as RoutineDraft["sourceSelection"] },
                        }))}
                        disabled={busy}
                      >
                        <option value="recent_authorized">Recent authorized conversations</option>
                        <option value="named_sources">Named sources only</option>
                        <option value="all_authorized">Everything authorized</option>
                      </select>
                    </label>
                    <label>
                      Audience
                      <select
                        value={draft.audience}
                        onChange={(event) => setRoutineDrafts((state) => ({
                          ...state,
                          [workflow.packageId]: { ...draft, audience: event.target.value as RoutineDraft["audience"] },
                        }))}
                        disabled={busy}
                      >
                        <option value="private">Private to me</option>
                        <option value="team">Team-ready draft</option>
                        <option value="draft">Draft only</option>
                      </select>
                    </label>
                    <label>
                      Output volume
                      <select
                        value={draft.outputVolume}
                        onChange={(event) => setRoutineDrafts((state) => ({
                          ...state,
                          [workflow.packageId]: { ...draft, outputVolume: event.target.value as RoutineDraft["outputVolume"] },
                        }))}
                        disabled={busy}
                      >
                        <option value="short">Short</option>
                        <option value="standard">Standard</option>
                        <option value="detailed">Detailed</option>
                      </select>
                    </label>
                    <button
                      onClick={() => void postWorkflowIntent(workflow, "tune_package", {
                        expectedVersion: workflow.settingsVersion,
                        settings: draft,
                      })}
                      disabled={busy}
                    >
                      Save changes
                    </button>
                  </div>
                </details>
                <div className="skill-actions">
                  <button
                    onClick={() => void postWorkflowIntent(workflow, "generate_new_request", {
                      scope: { packageId: workflow.packageId, targetRef: `package:${workflow.packageId}` },
                      prompt: `Run ${workflow.displayName} now.`,
                    })}
                    disabled={busy || workflow.disabled}
                  >
                    Run now
                  </button>
                  <button
                    onClick={() => void postWorkflowIntent(workflow, "ask_feed", {
                      prompt: `Use ${workflow.displayName} to answer from my latest authorized context.`,
                    })}
                    disabled={busy || workflow.disabled}
                  >
                    Ask Feed
                  </button>
                  {workflow.disabled ? (
                    <button
                      onClick={() => void postWorkflowIntent(workflow, "enable_package", {
                        expectedVersion: workflow.settingsVersion,
                      })}
                      disabled={busy}
                    >
                      Add back
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={() => void postWorkflowIntent(
                          workflow,
                          workflow.paused ? "enable_package" : "pause_package",
                          { expectedVersion: workflow.settingsVersion },
                        )}
                        disabled={busy}
                      >
                        {workflow.paused ? "Enable" : "Pause"}
                      </button>
                      <button
                        onClick={() => void postWorkflowIntent(workflow, "disable_package", {
                          expectedVersion: workflow.settingsVersion,
                        })}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => void postWorkflowIntent(workflow, "reset_package", {
                      expectedVersion: workflow.settingsVersion,
                    })}
                    disabled={busy}
                  >
                    Reset
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="settings-subsection">
        <h3>Named transcript sources</h3>
        <p>
          Additional sources are attached through TinyCloud’s browser share flow. Raw share links and private keys
          stay in the browser; Feed Host receives only a restricted child delegation.
        </p>
        {loadState === "ready" && inputAuthorities.length === 0 && (
          <p>No additional transcript sources attached. Your ordinary Feed access is unchanged.</p>
        )}
        {inputAuthorityError && <p className="error">Named source status is unavailable: {inputAuthorityError}</p>}
        <form
          className="skill-row"
          onSubmit={(event) => {
            event.preventDefault();
            const sourceId = newSource.sourceId.trim();
            const displayName = newSource.displayName.trim();
            const tc1Link = newSource.tc1Link.trim();
            if (!sourceId || !displayName || !tc1Link) return;
            setBusySourceId(sourceId);
            void attachReceivedInputAuthority({ client, policy, sourceId, displayName, tc1Link })
              .then(() => {
                setNewSource({ sourceId: "", displayName: "", tc1Link: "" });
                return reload();
              })
              .catch((error) => setLoadError(formatHostError(error)))
              .finally(() => setBusySourceId(null));
          }}
        >
          <div className="skill-summary">
            <strong>Attach a transcript source</strong>
            <span>The received-share link is attenuated locally and is never sent to Feed Host.</span>
          </div>
          <div className="skill-actions">
            <label>
              Source ID
              <input value={newSource.sourceId} onChange={(event) => setNewSource((state) => ({ ...state, sourceId: event.target.value }))} />
            </label>
            <label>
              Display name
              <input value={newSource.displayName} onChange={(event) => setNewSource((state) => ({ ...state, displayName: event.target.value }))} />
            </label>
            <label>
              TinyCloud share link
              <input type="password" value={newSource.tc1Link} onChange={(event) => setNewSource((state) => ({ ...state, tc1Link: event.target.value }))} />
            </label>
            <button type="submit" disabled={busySourceId !== null || !newSource.tc1Link.trim()}>Attach source</button>
          </div>
        </form>
        <ul className="skill-list">
          {inputAuthorities.map((authority) => (
            <li key={authority.sourceId} className="skill-row">
              <div className="skill-summary">
                <strong>{authority.displayName}</strong>
                <span>{authority.state} · {authority.path}</span>
                <span>Expires {new Date(authority.expiry).toLocaleString()}</span>
              </div>
              <div className="skill-actions">
                <button
                  disabled={busySourceId === authority.sourceId || authority.state === "revoked"}
                  onClick={() => {
                    setBusySourceId(authority.sourceId);
                    void client.revokeInputAuthority(authority.sourceId)
                      .then(reload)
                      .catch((error) => setLoadError(formatHostError(error)))
                      .finally(() => setBusySourceId(null));
                  }}
                >
                  Revoke
                </button>
                <button
                  disabled={busySourceId === authority.sourceId}
                  onClick={() => {
                    setBusySourceId(authority.sourceId);
                    void client.removeInputAuthority(authority.sourceId)
                      .then(reload)
                      .catch((error) => setLoadError(formatHostError(error)))
                      .finally(() => setBusySourceId(null));
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {loadState === "ready" && skills.length === 0 && (
        <p>No skill credentials attached yet. Attach one below by entering a provider and reference name.</p>
      )}
      <form
        className="skill-row"
        onSubmit={(event) => {
          event.preventDefault();
          const skillId = newSkill.skillId.trim();
          const providerId = newSkill.providerId.trim();
          const secretRef = newSkill.secretRef.trim();
          if (!skillId || !secretRef) return;
          void patch(skillId, 0, "user_byok_api_key", providerId || undefined, secretRef, () => {
            setNewSkill({ skillId: "", providerId: "", secretRef: "" });
          });
        }}
      >
        <div className="skill-summary">
          <strong>Attach a new skill</strong>
          <span>Creates an actor-scoped credential setting at version 1.</span>
        </div>
        <div className="skill-actions">
          <label>
            Skill ID
            <input
              value={newSkill.skillId}
              onChange={(event) => setNewSkill((state) => ({ ...state, skillId: event.target.value }))}
              disabled={busySkillId !== null}
            />
          </label>
          <label>
            New skill provider
            <input
              value={newSkill.providerId}
              onChange={(event) => setNewSkill((state) => ({ ...state, providerId: event.target.value }))}
              disabled={busySkillId !== null}
            />
          </label>
          <label>
            New skill secret reference
            <input
              type="password"
              value={newSkill.secretRef}
              onChange={(event) => setNewSkill((state) => ({ ...state, secretRef: event.target.value }))}
              placeholder="vault/secrets/..."
              disabled={busySkillId !== null}
            />
          </label>
          <button
            type="submit"
            disabled={busySkillId !== null || !newSkill.skillId.trim() || !newSkill.secretRef.trim()}
          >
            Attach credential
          </button>
        </div>
      </form>
      <ul className="skill-list">
        {skills.map((skill) => {
          const draft = inputs[skill.skillId] ?? { providerId: skill.providerId ?? "", secretRef: "" };
          const busy = busySkillId === skill.skillId;
          return (
            <li key={skill.skillId} className="skill-row">
              <div className="skill-summary">
                <strong>{skill.skillId}</strong>
                <span>mode: {skill.credentialMode}</span>
                <span>{skill.hasSecret ? "credential attached" : "no credential"}</span>
                <span>v{skill.version}</span>
              </div>
              <div className="skill-actions">
                <label>
                  Provider
                  <input
                    value={draft.providerId}
                    onChange={(event) =>
                      setInputs((state) => ({
                        ...state,
                        [skill.skillId]: { ...draft, providerId: event.target.value },
                      }))
                    }
                    disabled={busy}
                  />
                </label>
                <label>
                  Secret reference
                  <input
                    type="password"
                    value={draft.secretRef}
                    onChange={(event) =>
                      setInputs((state) => ({
                        ...state,
                        [skill.skillId]: { ...draft, secretRef: event.target.value },
                      }))
                    }
                    placeholder={skill.hasSecret ? "leave blank to keep existing" : "vault/secrets/..."}
                    disabled={busy}
                  />
                </label>
                <button
                  onClick={() =>
                    void patch(
                      skill.skillId,
                      skill.version,
                      "user_byok_api_key",
                      draft.providerId.trim() || undefined,
                      draft.secretRef.trim() || undefined,
                    )
                  }
                  disabled={busy || (!skill.hasSecret && !draft.secretRef.trim())}
                >
                  {skill.hasSecret ? "Replace" : "Attach"}
                </button>
                <button
                  onClick={() => void patch(skill.skillId, skill.version, "none")}
                  disabled={busy || !skill.hasSecret}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="disconnect-row">
        <div><strong>Disconnect Feed</strong><span>Stops this Feed Host from using your saved access.</span></div>
        <button className="danger-button" onClick={onDisconnect}>Disconnect Feed</button>
      </div>
    </section>
  );
}
