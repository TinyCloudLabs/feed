import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
import { isFeedReconnectRequiredError } from "./authPolicy.ts";
import { errorDetail, reportClientEvent, reportStartupTiming } from "./clientLog.ts";
import type { FeedHostDelegationPolicy } from "./delegation.ts";
import {
  FeedV1HostClient,
  FeedV1HostError,
  type FeedHostSkillState,
} from "./feedV1HostClient.ts";
import { bodyPreview, projectionLabel, sortedFeed, type FeedItem } from "./feedModel.ts";
import { StartupTrace, type StartupFlow } from "./startupTiming.ts";

type LoadState = "idle" | "loading" | "ready" | "error";
type FeedState = "idle" | "starting" | "running" | "error";
type SetupStage = "identity" | "context" | "preparing";

const FEED_EVENTS_RETRY_MS = 5000;
const RECOVERY_COOLDOWN_MS = 30_000;

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function newNonce(): string {
  return crypto.randomUUID();
}

function newStartupTrace(flow: StartupFlow): StartupTrace {
  return new StartupTrace(flow, reportStartupTiming);
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
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const feedLoadInFlight = useRef(false);
  const setupInFlight = useRef(false);
  const lastRecoveryAt = useRef(0);
  const timingRef = useRef<StartupTrace>(newStartupTrace("session_restore"));

  const client = useMemo(
    () => new FeedV1HostClient({
      baseUrl: FEED_HOST_URL,
      token: FEED_HOST_TOKEN || undefined,
      actorId: session?.readerDid,
      traceId: () => timingRef.current.traceId,
    }),
    [session?.readerDid],
  );

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const timing = timingRef.current;
      timing.mark("page_loaded");
      const nextPolicy = await timing.measure("policy_fetch", () => client.getDelegationPolicy());
      if (cancelled) return;
      setPolicy(nextPolicy);
      const restored = await restoreSession(nextPolicy, timing);
      if (!cancelled && restored) setSession(restored);
      if (!cancelled && !restored) timing.complete("signed_out");
    };
    bootstrap()
      .then(() => undefined)
      .catch((error: unknown) => {
        timingRef.current.complete("error");
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
      const timing = newStartupTrace("delegation_recovery");
      timingRef.current = timing;
      timing.mark("recovery_started");
      const nextPolicy = await timing.measure("policy_fetch", () => client.getDelegationPolicy());
      setFeedState("starting");
      setSetupStage("context");
      setPolicy(nextPolicy);
      return true;
    } catch (error) {
      timingRef.current.complete("error");
      reportClientEvent("error", "delegation_recovery_failed", errorDetail(error), session?.readerDid);
      return false;
    }
  }, [client, session]);

  const loadFeed = useCallback(async () => {
    if (!session || feedLoadInFlight.current) return;
    feedLoadInFlight.current = true;
    setLoadState("loading");
    const timing = timingRef.current;
    try {
      const page = await timing.measure("feed_page_fetch", () => client.listFeed({ limit: 40 }));
      const hydrated = await timing.measure("artifact_hydration", () => Promise.all(
        page.items.map(async (projection): Promise<FeedItem> => {
          try {
            const artifact = await client.getArtifact(projection.artifactId);
            return { projection, artifact };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { projection, artifact: null, error: message };
          }
        }),
      ));
      setItems(sortedFeed(hydrated));
      setLoadError(null);
      setLoadState("ready");
    } catch (error) {
      if (isDelegationLostError(error)) {
        feedLoadInFlight.current = false;
        if (await recoverDelegation()) return;
      }
      reportClientEvent("error", "feed_load_failed", errorDetail(error), session.readerDid);
      timing.complete("error");
      setLoadState("error");
      setLoadError(formatHostError(error));
    } finally {
      feedLoadInFlight.current = false;
    }
  }, [client, recoverDelegation, session]);

  const resetFeedState = useCallback(() => {
    setFeedState("idle");
    setSetupStage("identity");
    setSetupError(null);
    setItems([]);
    setLoadState("idle");
    setLoadError(null);
    setBusyAction(null);
  }, []);

  const startFeed = useCallback(
    async () => {
      if (!session || !policy || setupInFlight.current) return;
      setupInFlight.current = true;
      setFeedState("starting");
      setSetupStage("context");
      setSetupError(null);
      setLoadError(null);
      try {
        const timing = timingRef.current;
        await timing.measure("feed_host_setup", () => submitFeedHostDelegations({
          client,
          policy,
          actorId: session.readerDid,
          timing,
        }));
        setSetupStage("preparing");
        await loadFeed();
        setFeedState("running");
      } catch (error) {
        console.error("[Feed setup]", error);
        if (isFeedReconnectRequiredError(error)) {
          timingRef.current.complete("error");
          reportClientEvent("warn", "feed_reconnect_required", errorDetail(error), session.readerDid);
          await signOut().catch(() => undefined);
          setSession(null);
          setSignInError(error.message);
          resetFeedState();
          return;
        }
        reportClientEvent("error", "feed_setup_failed", errorDetail(error), session.readerDid);
        timingRef.current.complete("error");
        setFeedState("error");
        setSetupError(`Feed could not finish connecting (${errorDetail(error)}). Check your connection and try again.`);
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
    void startFeed();
  }, [policy, session, startFeed]);

  useEffect(() => {
    if (feedState !== "running" || loadState !== "ready") return;
    const timing = timingRef.current;
    const frame = window.requestAnimationFrame(() => {
      timing.mark("first_feed_render");
      timing.complete("ok");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [feedState, loadState]);

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
  }, [client, feedState, loadFeed, recoverDelegation, session]);

  const connect = async () => {
    setSignInError(null);
    const timing = newStartupTrace("interactive_sign_in");
    timingRef.current = timing;
    timing.mark("user_started");
    try {
      const nextPolicy = policy ?? (await timing.measure("policy_fetch", () => client.getDelegationPolicy()));
      if (policy) timing.mark("policy_cached");
      setPolicy(nextPolicy);
      resetFeedState();
      setSession(await signIn(nextPolicy, timing));
    } catch (error) {
      timing.complete("error");
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

  const sendFeedback = async (projection: FeedArtifactProjection, signal: FeedbackEvent["signal"]) => {
    if (!session || feedState !== "running") return;
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
    if (!session || feedState !== "running") return;
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
        <div>
          <h1>Feed</h1>
          <p>For you</p>
        </div>
        <div className="topbar-actions">
          <span className="identity">{shortAddress(session.address)}</span>
          <button onClick={() => void loadFeed()}>
            Refresh
          </button>
          <button className="primary" onClick={() => void sendAskFeed()} disabled={busyAction === "ask_feed"}>
            Ask Feed
          </button>
          <button onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>
            {settingsOpen ? "Close" : "Access & automation"}
          </button>
          <button onClick={() => void disconnect()}>Sign out</button>
        </div>
      </header>

      {settingsOpen && (
        <SkillCredentialsPanel client={client} onDisconnect={() => void disconnect()} />
      )}

      <main className="content-shell">
        {loadState === "loading" && loadError === null && (
          <NoticePanel
            tone="info"
            title="Refreshing your Feed"
            detail="Checking for useful items from your recent context."
          />
        )}

        {loadError !== null && (
          <FeedFailurePanel error={loadError ?? "The feed could not be loaded."} onRetry={() => void loadFeed()} />
        )}

        {loadState === "ready" && loadError === null && items.length === 0 && (
          <EmptyFeedPanel onRetry={() => void loadFeed()} />
        )}

        <div className="feed-list">
          {items.map((item) => (
            <FeedCard key={item.projection.artifactId} item={item} busyAction={busyAction} onFeedback={sendFeedback} />
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
          <dt>Made by</dt>
          <dd>Feed</dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd>{artifact?.freshness.label ?? item.projection.freshnessLabel}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{artifact?.sourceRefs.length ?? 1} Listen conversation{(artifact?.sourceRefs.length ?? 1) === 1 ? "" : "s"}</dd>
        </div>
      </dl>
      <div className="card-actions">
        {(["save", "hide", "helpful", "unhelpful", "show_fewer"] as const).map((signal) => (
          <button
            key={signal}
            disabled={busyAction === `${item.projection.artifactId}:${signal}`}
            onClick={() => void onFeedback(item.projection, signal)}
          >
            {feedbackLabel(signal)}
          </button>
        ))}
      </div>
    </article>
  );
}

function feedbackLabel(signal: FeedbackEvent["signal"]): string {
  switch (signal) {
    case "save": return "Save";
    case "hide": return "Hide";
    case "helpful": return "Helpful";
    case "unhelpful": return "Not helpful";
    case "show_fewer": return "Less like this";
    case "unsave": return "Remove from saved";
    case "unhide": return "Show again";
    case "text_note": return "Add note";
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
  if (error instanceof FeedV1HostError) return `${error.status}: ${error.body || error.message}`;
  return error instanceof Error ? error.message : String(error);
}

// The host reports a missing/stale delegation as 403 insufficient_policy or
// denied, or 409 delegation_stale — all recoverable by re-submitting.
function isDelegationLostError(error: unknown): boolean {
  if (!(error instanceof FeedV1HostError)) return false;
  if (error.status === 409) return error.body.includes("delegation_stale");
  if (error.status === 403) return error.body.includes("insufficient_policy") || error.body.includes("denied");
  return false;
}

function SkillCredentialsPanel({
  client,
  onDisconnect,
}: {
  client: FeedV1HostClient;
  onDisconnect: () => void;
}) {
  const [skills, setSkills] = useState<FeedHostSkillState[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Record<string, { providerId: string; secretRef: string }>>({});
  const [newSkill, setNewSkill] = useState({ skillId: "", providerId: "", secretRef: "" });

  const reload = useCallback(async () => {
    setLoadState("loading");
    try {
      const page = await client.listSkills({ limit: 50 });
      setSkills(page.items);
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
      await client.patchSkillCredentials(skillId, {
        expectedVersion,
        credentialMode: mode,
        providerId,
        secretRef,
      });
      onSuccess?.();
      await reload();
    } catch (error) {
      setLoadError(formatHostError(error));
    } finally {
      setBusySkillId(null);
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
