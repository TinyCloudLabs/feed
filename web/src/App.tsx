import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  ControlIntentEvent,
  FeedArtifact,
  FeedbackEvent,
} from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import { type FeedItemProjection, type FeedPost } from "../../shared/feed-item.ts";
import { ArtifactPage, type ArtifactPageState } from "./ArtifactPage.tsx";
import { FEED_HOST_TOKEN, FEED_HOST_URL } from "./config.ts";
import {
  attachReceivedInputAuthority,
  restoreSession,
  signIn,
  signOut,
  submitFeedHostDelegations,
  type FeedLoginTrace,
  type FeedSession,
} from "./authLazy.ts";
import {
  FeedReconnectRequiredError,
  MISSING_PARENT_RECONNECT_MESSAGE,
  isFeedReconnectRequiredError,
} from "./authPolicy.ts";
import { errorDetail, reportClientEvent, reportClientTiming } from "./clientLog.ts";
import type { FeedHostDelegationPolicy } from "./delegation.ts";
import type { FeedHostSetupStatus } from "./delegation.ts";
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
  projectionCanHydrate,
  readableFeedTime,
  readablePostKind,
  readableProvenance,
  sortedFeed,
  type FeedItem,
  type FeedView,
} from "./feedModel.ts";
import { isMissingParentDelegationError } from "./missingParentDelegation.ts";

type LoadState = "idle" | "loading" | "ready" | "error";
type FeedState = "idle" | "starting" | "running" | "error";
type SetupStage = "identity" | "context" | "preparing";
type RoutineDraft = {
  cadence: "more" | "normal" | "less";
  sourceSelection: "recent_authorized" | "named_sources" | "all_authorized";
  audience: "private" | "team" | "draft";
  outputVolume: "short" | "standard" | "detailed";
};

const FEED_EVENTS_RETRY_MS = 15_000;
// The x-feed-trace-id request header is only understood by Feed Hosts that
// allowlist it in CORS; a host running an older build rejects EVERY request
// at preflight when the browser asks for it. Keep it opt-in until the
// deployed host is known to accept it. Trace ids still flow via client-event
// bodies either way.
const TRACE_HEADER_ENABLED = import.meta.env.VITE_FEED_TRACE_HEADER === "1";
const SETUP_STATUS_POLL_MS = 1000;
const RECOVERY_COOLDOWN_MS = 30_000;
// Time budget for restoring the feed scroll position after returning from an
// artifact page. The list can render below viewport height for a few hundred
// milliseconds while cards refill; a frame-count cap gave up during exactly
// that window (observed via scroll instrumentation), so the budget is
// wall-clock and generous. Route changes cancel the loop via effect cleanup.
const SCROLL_RESTORE_BUDGET_MS = 4000;
const DEFAULT_ROUTINE_DRAFT: RoutineDraft = {
  cadence: "normal",
  sourceSelection: "recent_authorized",
  audience: "private",
  outputVolume: "standard",
};

type ArtifactRoute = {
  feedItemId: string;
  artifactId: string;
  postId?: string;
};

export function currentRoute(hash = typeof location === "undefined" ? "" : location.hash): ArtifactRoute | null {
  const match = hash.match(/^#\/a\/(.+)$/);
  if (!match) return null;
  let feedItemId: string;
  try {
    feedItemId = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  if (!feedItemId) return null;
  const separator = feedItemId.indexOf("::");
  const legacy = feedItemId.startsWith("legacy:");
  const artifactId = legacy
    ? feedItemId.slice("legacy:".length)
    : separator >= 0
      ? feedItemId.slice(0, separator)
      : feedItemId;
  if (!artifactId) return null;
  if (separator < 0) return { feedItemId, artifactId };
  const encodedPostId = feedItemId.slice(separator + 2);
  try {
    return { feedItemId, artifactId, postId: decodeURIComponent(encodedPostId) };
  } catch {
    return { feedItemId, artifactId };
  }
}

class FeedSetupFailedError extends Error {
  constructor(readonly setup: FeedHostSetupStatus) {
    super(setup.error?.message ?? "Feed Host preparation failed");
    this.name = "FeedSetupFailedError";
  }
}

class FeedSetupCancelledError extends Error {
  constructor() {
    super("Feed setup no longer belongs to the active session");
    this.name = "FeedSetupCancelledError";
  }
}

function shortAddress(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

function newNonce(): string {
  return crypto.randomUUID();
}

export type AppAuthDependencies = {
  attachReceivedInputAuthority: typeof attachReceivedInputAuthority;
  restoreSession: typeof restoreSession;
  signIn: typeof signIn;
  signOut: typeof signOut;
  submitFeedHostDelegations: typeof submitFeedHostDelegations;
};

const DEFAULT_AUTH: AppAuthDependencies = {
  attachReceivedInputAuthority,
  restoreSession,
  signIn,
  signOut,
  submitFeedHostDelegations,
};

const DEFAULT_CREATE_CLIENT = (
  options: ConstructorParameters<typeof FeedV1HostClient>[0],
): FeedV1HostClient => new FeedV1HostClient(options);

type AppProps = {
  auth?: AppAuthDependencies;
  createClient?: (options: ConstructorParameters<typeof FeedV1HostClient>[0]) => FeedV1HostClient;
};

export function App({
  auth = DEFAULT_AUTH,
  createClient = DEFAULT_CREATE_CLIENT,
}: AppProps = {}) {
  const [session, setSession] = useState<FeedSession | null>(null);
  const [policy, setPolicy] = useState<FeedHostDelegationPolicy | null>(null);
  const [restoreDone, setRestoreDone] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const [feedState, setFeedState] = useState<FeedState>("idle");
  const [setupStage, setSetupStage] = useState<SetupStage>("identity");
  const [hostSetup, setHostSetup] = useState<FeedHostSetupStatus | null>(null);
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
  const [route, setRoute] = useState<ArtifactRoute | null>(() => currentRoute());
  const [pageArtifact, setPageArtifact] = useState<FeedArtifact | null>(null);
  const [pageLoadState, setPageLoadState] = useState<ArtifactPageState>("loading");
  const [pageLoadError, setPageLoadError] = useState<string | undefined>();
  const [pageRequestArtifactId, setPageRequestArtifactId] = useState<string | null>(null);
  const [pageRetry, setPageRetry] = useState(0);
  const feedLoadInFlight = useRef(false);
  const setupInFlight = useRef<number | null>(null);
  const artifactHydrationQueue = useRef<Promise<void>>(Promise.resolve());
  const lastRecoveryAt = useRef(0);
  const loginTrace = useRef<FeedLoginTrace | null>(null);
  const firstContentReported = useRef<string | null>(null);
  const restoredHostSession = useRef(false);
  // Async setup work captures this value. Teardown and new sign-ins advance
  // it before awaiting, so late work from an old session cannot clear or
  // mutate a newer session.
  const sessionGeneration = useRef(0);
  const feedbackAttempts = useRef(new Map<string, { eventId: string; readerNonce: string }>());
  const routeRef = useRef(route);
  const enteredFromFeed = useRef(false);
  const savedFeedScrollY = useRef(0);
  const pendingFeedScrollY = useRef<number | null>(null);

  const client = useMemo(
    () => createClient({
      baseUrl: FEED_HOST_URL,
      token: FEED_HOST_TOKEN || undefined,
      actorId: session?.readerDid,
      traceId: loginTrace.current?.traceId,
    }),
    [createClient, session?.readerDid],
  );
  const artifactCache = useMemo(() => createLazyArtifactCache((artifactId) => client.getArtifact(artifactId)), [client]);

  useEffect(() => {
    const previousScrollRestoration = history.scrollRestoration;
    history.scrollRestoration = "manual";
    // Capture the feed's scroll position at the moment a hash link is
    // clicked. Anything later is too late: the browser scrolls to top for the
    // unmatched fragment (firing its own scroll event) BEFORE hashchange, so
    // both capture-on-hashchange and a continuous scroll tracker record 0
    // (verified with scroll instrumentation).
    const onCaptureClick = (event: MouseEvent) => {
      if (routeRef.current) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href^='#/']");
      if (anchor) savedFeedScrollY.current = window.scrollY;
    };
    const onHashChange = () => {
      const previous = routeRef.current;
      const next = currentRoute();
      if (!previous && next) {
        pendingFeedScrollY.current = null;
        enteredFromFeed.current = true;
      } else if (previous && !next) {
        pendingFeedScrollY.current = savedFeedScrollY.current;
      }
      routeRef.current = next;
      setRoute(next);
      setMenuOpen(false);
    };
    window.addEventListener("click", onCaptureClick, { capture: true });
    window.addEventListener("hashchange", onHashChange);
    return () => {
      window.removeEventListener("click", onCaptureClick, { capture: true });
      window.removeEventListener("hashchange", onHashChange);
      history.scrollRestoration = previousScrollRestoration;
    };
  }, []);

  const returnToFeed = useCallback(() => {
    if (enteredFromFeed.current) {
      enteredFromFeed.current = false;
      history.back();
      return;
    }
    location.hash = "";
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const startedAt = performance.now();
      const trace: FeedLoginTrace = {
        traceId: crypto.randomUUID(),
        loginStartedAt: startedAt,
        systemStartedAt: startedAt,
        sessionMode: "restored",
      };
      loginTrace.current = trace;
      if (TRACE_HEADER_ENABLED) client.setTraceId(trace.traceId);
      const policyStartedAt = performance.now();
      const nextPolicy = await client.getDelegationPolicy();
      reportClientTiming("login_policy_received", { ...trace, phaseStartedAt: policyStartedAt });
      if (cancelled) return;
      setPolicy(nextPolicy);
      const restoreStartedAt = performance.now();
      const restored = await auth.restoreSession(nextPolicy);
      if (!cancelled && restored) {
        restoredHostSession.current = true;
        reportClientTiming("login_session_restored", {
          ...trace,
          phaseStartedAt: restoreStartedAt,
          actorId: restored.readerDid,
        });
        sessionGeneration.current += 1;
        setSession(restored);
      } else if (!restored) {
        loginTrace.current = null;
        client.setTraceId(undefined);
      }
    };
    bootstrap()
      .then(() => undefined)
      .catch((error: unknown) => {
        if (!cancelled) {
          setReconnectRequired(false);
          setSignInError(error instanceof Error ? error.message : String(error));
        }
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
    restoredHostSession.current = false;
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

  const loadFeed = useCallback(async (options: {
    recoverDelegation?: boolean;
    surfaceError?: boolean;
    reason?: string;
  } = {}): Promise<boolean> => {
    if (!session || feedLoadInFlight.current) return false;
    const recoverLostDelegation = options.recoverDelegation !== false;
    const surfaceError = options.surfaceError !== false;
    feedLoadInFlight.current = true;
    if (surfaceError) setLoadState("loading");
    const phaseStartedAt = performance.now();
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
      if (loginTrace.current) {
        reportClientTiming("login_feed_projections_received", {
          ...loginTrace.current,
          phaseStartedAt,
          actorId: session.readerDid,
          detail: `items=${page.items.length} reason=${options.reason ?? "refresh"}`,
        });
      }
      return true;
    } catch (error) {
      if (recoverLostDelegation && isDelegationLostError(error)) {
        feedLoadInFlight.current = false;
        if (await recoverDelegation()) return false;
      }
      reportClientEvent(
        surfaceError ? "error" : "info",
        surfaceError ? "feed_load_failed" : "feed_fast_path_missed",
        errorDetail(error),
        session.readerDid,
        loginTrace.current ? { traceId: loginTrace.current.traceId } : {},
      );
      if (surfaceError) {
        setLoadState("error");
        setLoadError(formatHostError(error));
      }
      return false;
    } finally {
      feedLoadInFlight.current = false;
    }
  }, [artifactCache, client, recoverDelegation, session]);

  const resetFeedState = useCallback(() => {
    setFeedState("idle");
    setSetupStage("identity");
    setHostSetup(null);
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
    firstContentReported.current = null;
  }, [artifactCache]);

  const requireReconnect = useCallback(async (
    error: FeedReconnectRequiredError,
    expectedGeneration = sessionGeneration.current,
  ) => {
    if (sessionGeneration.current !== expectedGeneration) return;
    const reconnectGeneration = expectedGeneration + 1;
    sessionGeneration.current = reconnectGeneration;
    reportClientEvent("warn", "feed_reconnect_required", undefined, session?.readerDid);
    await auth.signOut({ preserveAddress: true }).catch(() => undefined);
    if (sessionGeneration.current !== reconnectGeneration) return;
    setSession(null);
    setSignInError(error.message);
    setReconnectRequired(true);
    restoredHostSession.current = false;
    resetFeedState();
  }, [auth, resetFeedState, session?.readerDid]);

  const requireMissingParentReconnect = useCallback(async (
    error: unknown,
    expectedGeneration = sessionGeneration.current,
  ) => {
    if (sessionGeneration.current !== expectedGeneration) return;
    reportClientEvent("warn", "missing_parent_recovery", undefined, session?.readerDid, {
      session_mode: loginTrace.current?.sessionMode ?? "restored",
      stage: "activate",
      outcome: "reconnect_required",
    });
    await requireReconnect(
      new FeedReconnectRequiredError(error, MISSING_PARENT_RECONNECT_MESSAGE),
      expectedGeneration,
    );
  }, [requireReconnect, session?.readerDid]);

  const waitForHostSetup = useCallback(async (expectedGeneration: number): Promise<void> => {
    let previousPhase: FeedHostSetupStatus["phase"] | undefined;
    let phaseStartedAt = performance.now();
    for (;;) {
      if (sessionGeneration.current !== expectedGeneration) throw new FeedSetupCancelledError();
      const status = await client.getDelegationStatus();
      if (sessionGeneration.current !== expectedGeneration) throw new FeedSetupCancelledError();
      if (!status.complete) throw new Error(`Feed Host delegation is ${status.state}`);
      if (status.setup) {
        setHostSetup(status.setup);
        if (status.setup.phase !== previousPhase) {
          if (loginTrace.current) {
            reportClientTiming("login_setup_phase", {
              ...loginTrace.current,
              phaseStartedAt,
              actorId: session?.readerDid,
              detail: `phase=${status.setup.phase}`,
            });
          }
          previousPhase = status.setup.phase;
          phaseStartedAt = performance.now();
        }
      }
      if (status.setup?.state === "ready") {
        if (loginTrace.current) {
          reportClientTiming("login_setup_ready", {
            ...loginTrace.current,
            phaseStartedAt,
            actorId: session?.readerDid,
          });
        }
        return;
      }
      if (status.setup?.state === "failed") throw new FeedSetupFailedError(status.setup);
      await new Promise((resolve) => window.setTimeout(resolve, SETUP_STATUS_POLL_MS));
    }
  }, [client, session?.readerDid]);

  const recordSetupFailure = useCallback((error: unknown) => {
    console.error("[Feed setup]", error);
    if (error instanceof FeedSetupFailedError) setHostSetup(error.setup);
    reportClientEvent("error", "feed_setup_failed", errorDetail(error), session?.readerDid);
    setFeedState("error");
    setSetupError("Feed’s backend could not finish preparing your Feed.");
  }, [session?.readerDid]);

  const startFeed = useCallback(
    async () => {
      if (!session || !policy) return;
      const setupGeneration = sessionGeneration.current;
      if (setupInFlight.current === setupGeneration) return;
      setupInFlight.current = setupGeneration;
      setFeedState("starting");
      setHostSetup(null);
      setSetupError(null);
      setLoadError(null);
      try {
        // A returning browser usually still has a valid Feed Host session.
        // Read first so existing content never waits for delegation refresh or
        // schema preparation.
        if (restoredHostSession.current) {
          const restoredFeed = await loadFeed({
            recoverDelegation: false,
            surfaceError: false,
            reason: "restored_host_session",
          });
          if (restoredFeed) {
            setFeedState("running");
            return;
          }
          restoredHostSession.current = false;
        }

        setSetupStage("context");
        const [receipt] = await auth.submitFeedHostDelegations({
          client,
          policy,
          actorId: session.readerDid,
          trace: loginTrace.current ?? undefined,
        });
        if (receipt?.setup) setHostSetup(receipt.setup);
        setSetupStage("preparing");
        const setup = waitForHostSetup(setupGeneration).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const existingFeed = await loadFeed({
          recoverDelegation: false,
          surfaceError: false,
          reason: "new_host_session",
        });
        if (existingFeed) {
          setFeedState("running");
          void setup.then((result) => {
            if (result.ok || result.error instanceof FeedSetupCancelledError) return;
            if (sessionGeneration.current !== setupGeneration) return;
            if (isMissingParentDelegationError(result.error)) {
              void requireMissingParentReconnect(result.error, setupGeneration);
              return;
            }
            reportClientEvent("warn", "feed_background_setup_failed", errorDetail(result.error), session.readerDid,
              loginTrace.current ? { traceId: loginTrace.current.traceId } : {});
            setEventsError("Feed is available, but background preparation needs attention.");
          });
          return;
        }

        const setupResult = await setup;
        if (!setupResult.ok) throw setupResult.error;
        const firstFeed = await loadFeed({ reason: "setup_complete" });
        if (!firstFeed) throw new Error("Feed did not become readable after setup completed");
        setFeedState("running");
      } catch (error) {
        if (error instanceof FeedSetupCancelledError) return;
        if (isFeedReconnectRequiredError(error)) {
          await requireReconnect(error, setupGeneration);
          return;
        }
        if (isMissingParentDelegationError(error)) {
          await requireMissingParentReconnect(error, setupGeneration);
          return;
        }
        recordSetupFailure(error);
      } finally {
        if (setupInFlight.current === setupGeneration) setupInFlight.current = null;
      }
    },
    [auth, client, loadFeed, policy, recordSetupFailure, requireMissingParentReconnect, requireReconnect, session, waitForHostSetup],
  );

  const retryFeedSetup = useCallback(async () => {
    if (!session) return;
    const setupGeneration = sessionGeneration.current;
    if (setupInFlight.current === setupGeneration) return;
    setupInFlight.current = setupGeneration;
    setFeedState("starting");
    setSetupStage("preparing");
    setSetupError(null);
    try {
      const response = await client.retrySetup();
      setHostSetup(response.setup);
      await waitForHostSetup(setupGeneration);
      await loadFeed();
      setFeedState("running");
    } catch (error) {
      if (error instanceof FeedSetupCancelledError) return;
      if (isFeedReconnectRequiredError(error)) {
        await requireReconnect(error, setupGeneration);
        return;
      }
      if (isMissingParentDelegationError(error)) {
        await requireMissingParentReconnect(error, setupGeneration);
        return;
      }
      recordSetupFailure(error);
    } finally {
      if (setupInFlight.current === setupGeneration) setupInFlight.current = null;
    }
  }, [client, loadFeed, recordSetupFailure, requireMissingParentReconnect, requireReconnect, session, waitForHostSetup]);

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
    let lastSignature: string | undefined;

    const pollFeedEvents = async () => {
      if (cancelled) return;
      try {
        const snapshot = await client.getFeedEvents();
        if (cancelled) return;
        setEventsError(null);
        const signature = snapshot.text.trim();
        if (lastSignature === undefined) {
          // The first snapshot establishes the cursor. It is the same state
          // loadFeed just rendered, so fetching it again only adds queue and
          // TinyCloud connection-pool pressure during initial hydration.
          lastSignature = signature;
        } else if (signature !== lastSignature) {
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
    const connectGeneration = sessionGeneration.current + 1;
    sessionGeneration.current = connectGeneration;
    setSignInError(null);
    setReconnectRequired(false);
    const loginStartedAt = performance.now();
    const trace: FeedLoginTrace = {
      traceId: crypto.randomUUID(),
      loginStartedAt,
      systemElapsedBeforeApprovalMs: 0,
      sessionMode: "fresh",
    };
    loginTrace.current = trace;
    restoredHostSession.current = false;
    if (TRACE_HEADER_ENABLED) client.setTraceId(trace.traceId);
    reportClientEvent("info", "login_clicked", undefined, undefined, {
      traceId: trace.traceId,
      session_mode: trace.sessionMode,
    });
    try {
      let nextPolicy = policy;
      if (!nextPolicy) {
        const policyStartedAt = performance.now();
        nextPolicy = await client.getDelegationPolicy();
        trace.systemElapsedBeforeApprovalMs = performance.now() - policyStartedAt;
        reportClientTiming("login_policy_received", { ...trace, phaseStartedAt: policyStartedAt });
      }
      setPolicy(nextPolicy);
      resetFeedState();
      const nextSession = await auth.signIn(nextPolicy, trace);
      if (sessionGeneration.current !== connectGeneration) return;
      trace.systemStartedAt = performance.now();
      reportClientEvent("info", "login_permissions_complete", undefined, nextSession.readerDid, {
        traceId: trace.traceId,
        elapsedMs: Math.round(trace.systemStartedAt - trace.loginStartedAt),
        session_mode: trace.sessionMode,
      });
      setReconnectRequired(false);
      setSession(nextSession);
    } catch (error) {
      if (sessionGeneration.current !== connectGeneration) return;
      reportClientEvent("error", "sign_in_failed", errorDetail(error), undefined, {
        traceId: trace.traceId,
        session_mode: trace.sessionMode,
      });
      setReconnectRequired(false);
      setSignInError(error instanceof Error ? error.message : String(error));
    }
  };

  const disconnect = async () => {
    const disconnectGeneration = sessionGeneration.current + 1;
    sessionGeneration.current = disconnectGeneration;
    try {
      await client.disconnectFeed();
    } catch {
      // Local sign-out still completes if the Host is already unavailable or disconnected.
    } finally {
      await auth.signOut().catch(() => undefined);
      if (sessionGeneration.current !== disconnectGeneration) return;
      setSession(null);
      setSignInError(null);
      setReconnectRequired(false);
      restoredHostSession.current = false;
      resetFeedState();
    }
  };

  const hydrateArtifact = useCallback(async (projection: FeedItemProjection): Promise<void> => {
    if (!projectionCanHydrate(projection)) return;
    const hydrate = artifactHydrationQueue.current.catch(() => undefined).then(async () => {
      try {
        const artifact = await artifactCache.load(projection.target.artifactId);
        setItems((current) => current.map((item) => item.projection.target.artifactId === projection.target.artifactId
          ? { ...item, artifact, error: undefined }
          : item));
      } catch (error) {
        // Authority rejected mid-session: re-submit the delegation instead of
        // letting every card decay into "unavailable" until a manual sign-in.
        // The cooldown inside recoverDelegation keeps a burst of failing
        // hydrations from re-triggering it.
        if (isDelegationLostError(error) && (await recoverDelegation())) return;
        const permanent = error instanceof FeedV1HostError && error.status === 424;
        setItems((current) => current.map((item) => item.projection.target.artifactId === projection.target.artifactId
          ? {
              ...item,
              artifact: null,
              error: permanent
                ? "This artifact is no longer available."
                : "This artifact is temporarily unavailable.",
            }
          : item));
      }
    });
    artifactHydrationQueue.current = hydrate.catch(() => undefined);
    await hydrate;
  }, [artifactCache, recoverDelegation]);

  const routedItem = route
    ? items.find((item) => item.projection.feedItemId === route.feedItemId)
    : undefined;
  const routedArtifactId = routedItem?.projection.target.artifactId ?? route?.artifactId;
  const routedPostId = routedItem?.projection.target.kind === "post"
    ? routedItem.projection.target.postId
    : route?.postId;
  const cachedPageArtifact = routedArtifactId ? artifactCache.peek(routedArtifactId) : undefined;
  const resolvedPageArtifact = routedItem?.artifact ?? cachedPageArtifact ?? (
    pageArtifact?.artifactId === routedArtifactId ? pageArtifact : null
  );

  useEffect(() => {
    if (!route || !routedArtifactId || feedState !== "running") return;
    if (resolvedPageArtifact) {
      setPageRequestArtifactId(routedArtifactId);
      setPageArtifact(resolvedPageArtifact);
      setPageLoadError(undefined);
      setPageLoadState("ready");
      return;
    }
    let cancelled = false;
    setPageRequestArtifactId(routedArtifactId);
    setPageArtifact(null);
    setPageLoadError(undefined);
    setPageLoadState("loading");
    artifactCache.load(routedArtifactId)
      .then((artifact) => {
        if (cancelled) return;
        setPageArtifact(artifact);
        setItems((current) => current.map((item) => item.projection.target.artifactId === routedArtifactId
          ? { ...item, artifact, error: undefined }
          : item));
        setPageLoadState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPageLoadError(formatHostError(error));
        setPageLoadState(error instanceof FeedV1HostError && (error.status === 404 || error.status === 424) ? "gone" : "error");
      });
    return () => {
      cancelled = true;
    };
  }, [artifactCache, feedState, pageRetry, resolvedPageArtifact, route?.feedItemId, routedArtifactId]);

  const sendFeedback = async (
    projection: Pick<FeedItemProjection, "feedItemId">,
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

  useLayoutEffect(() => {
    if (route || pendingFeedScrollY.current === null) return;
    const target = pendingFeedScrollY.current;
    let frame: number | undefined;
    const deadline = performance.now() + SCROLL_RESTORE_BUDGET_MS;
    const restore = () => {
      const scrollHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const maximumScrollY = Math.max(0, scrollHeight - window.innerHeight);
      if (maximumScrollY >= target) {
        window.scrollTo(0, target);
        pendingFeedScrollY.current = null;
        return;
      }
      if (performance.now() > deadline) {
        // The content never regained enough height; land as close as
        // possible and stop cleanly.
        window.scrollTo(0, maximumScrollY);
        pendingFeedScrollY.current = null;
        return;
      }
      frame = requestAnimationFrame(restore);
    };
    restore();
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [loadState, route, visibleItems.length]);

  useEffect(() => {
    const trace = loginTrace.current;
    if (!trace || firstContentReported.current === trace.traceId || items.length === 0) return;
    if (!items.some((item) => item.projection.postBody || item.projection.postTitle || item.artifact)) return;
    const frame = requestAnimationFrame(() => {
      firstContentReported.current = trace.traceId;
      reportClientTiming("login_first_content_visible", {
        ...trace,
        phaseStartedAt: trace.systemStartedAt ?? trace.loginStartedAt,
        actorId: session?.readerDid,
        detail: "budget_ms=5000 permission_time_excluded=true",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [items, session?.readerDid]);

  if (!restoreDone) {
    return <StatusScreen title="Opening Feed" detail="Checking your saved sign-in." />;
  }

  if (!session) {
    return (
      <SignInScreen
        error={signInError}
        reconnectRequired={reconnectRequired}
        onSignIn={() => void connect()}
      />
    );
  }

  if (feedState === "idle" || feedState === "starting") {
    return <SetupScreen stage={setupStage} setup={hostSetup} />;
  }

  if (feedState === "error") {
    return (
      <SetupFailurePanel
        error={setupError ?? "Feed could not finish connecting."}
        setup={hostSetup}
        onRetry={() => void (hostSetup?.state === "failed" ? retryFeedSetup() : startFeed())}
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
        <SkillCredentialsPanel
          client={client}
          policy={policy!}
          actorId={session.readerDid}
          onDisconnect={() => void disconnect()}
          onReconnectRequired={(error) => void requireReconnect(error, sessionGeneration.current)}
          attachInputAuthority={auth.attachReceivedInputAuthority}
        />
      )}

      {route && routedArtifactId ? (
        <ArtifactPage
          feedItemId={route.feedItemId}
          artifactId={routedArtifactId}
          artifact={resolvedPageArtifact}
          projection={routedItem?.projection}
          postId={routedPostId}
          state={resolvedPageArtifact
            ? "ready"
            : pageRequestArtifactId === routedArtifactId
              ? pageLoadState
              : "loading"}
          error={pageLoadError}
          heroUrl={client.heroUrl(routedArtifactId)}
          busyAction={busyAction}
          onBack={returnToFeed}
          onRetry={() => setPageRetry((value) => value + 1)}
          onFeedback={(signal, payload, attemptKey) => sendFeedback(
            { feedItemId: route.feedItemId },
            signal,
            payload,
            attemptKey,
          )}
          onResetAttempt={(attemptKey) => feedbackAttempts.current.delete(attemptKey)}
        />
      ) : <main
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
        </main>}
    </div>
  );
}

export function SignInScreen({
  error,
  reconnectRequired,
  onSignIn,
}: {
  error: string | null;
  reconnectRequired: boolean;
  onSignIn: () => void;
}) {
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
        <button className="primary signin-action" onClick={onSignIn}>
          {reconnectRequired ? "Sign in to reconnect" : "Sign in with OpenKey"}
        </button>
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

function SetupScreen({ stage, setup }: { stage: SetupStage; setup: FeedHostSetupStatus | null }) {
  const contextReady = stage === "preparing";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!contextReady || setup?.state !== "preparing") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [contextReady, setup?.state]);
  const elapsedSeconds = setup ? Math.max(0, Math.floor((now - Date.parse(setup.startedAt)) / 1000)) : 0;
  const activity = setupActivityLabel(setup?.phase);
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
            <span>
              <strong>{contextReady ? "Context connected" : "Connecting context"}</strong>
              <small>{contextReady ? "Allowed sources are readable." : "Activating secure access with Feed…"}</small>
            </span>
          </li>
          <li className={contextReady ? "current" : "pending"}>
            <span className="progress-mark" aria-hidden="true" />
            <span><strong>Preparing your first Feed</strong><small>Making useful items now.</small></span>
          </li>
        </ol>
        {contextReady && setup && (
          <div className="setup-live" aria-label="Backend setup status">
            <div className="setup-live-bar" aria-hidden="true"><span /></div>
            <p>
              <strong>{activity}</strong>
              <span>{elapsedSeconds}s</span>
            </p>
            <small>Backend phase: {setup.phase.replaceAll("_", " ")} · attempt {setup.attempt}</small>
          </div>
        )}
        <p className="setup-help">If anything needs attention, Feed will say what to reconnect.</p>
      </section>
    </main>
  );
}

function SetupFailurePanel({
  error,
  setup,
  onRetry,
  onSignInAgain,
}: {
  error: string;
  setup: FeedHostSetupStatus | null;
  onRetry: () => void;
  onSignInAgain: () => void;
}) {
  return (
    <main className="status-screen" role="alert">
      <p className="status-label">Feed needs attention</p>
      <h1>We couldn’t finish setting up your Feed.</h1>
      <p>{error}</p>
      {setup?.state === "failed" && (
        <details className="setup-error-detail">
          <summary>Backend details</summary>
          <p>Phase: {setup.phase} · attempt {setup.attempt}</p>
          {setup.error?.message && <p>{setup.error.message}</p>}
        </details>
      )}
      <div className="panel-actions">
        <button className="primary" onClick={onRetry}>{setup?.state === "failed" ? "Retry backend setup" : "Try again"}</button>
        <button onClick={onSignInAgain}>Sign in again</button>
      </div>
    </main>
  );
}

function setupActivityLabel(phase: FeedHostSetupStatus["phase"] | undefined): string {
  switch (phase) {
    case "bootstrap": return "Preparing secure storage…";
    case "artifact_check": return "Checking existing artifacts…";
    case "seed": return "Creating starter items…";
    case "reconcile": return "Building your Feed…";
    case "ready": return "Feed is ready";
    case "failed": return "Backend setup stopped";
    default: return "Starting the Feed backend…";
  }
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
  const cardRef = useRef<HTMLElement>(null);
  const artifact = item.artifact;
  const post = projectedPost(item);
  const provenance = readableProvenance(item);
  const availability = feedItemAvailability(item);
  const canHydrate = projectionCanHydrate(item.projection);
  const isSaved = item.projection.disposition === "saved";
  const title = item.projection.postTitle ?? post?.title ?? artifact?.title;
  // First verified quote reads as a distillery-style pull on the card face.
  const pullQuote = post?.evidence.find(
    (entry): entry is Extract<FeedPost["evidence"][number], { kind: "verified_quote" }> =>
      entry.kind === "verified_quote",
  );
  const loadArtifact = async () => {
    if (artifact || artifactLoading || !canHydrate) return;
    setArtifactLoading(true);
    await onExpand(item.projection);
    setArtifactLoading(false);
  };
  useEffect(() => {
    const element = cardRef.current;
    if (!element || artifact || !canHydrate || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void loadArtifact();
    }, { rootMargin: "300px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [artifact, canHydrate, item.projection.feedItemId]);
  const act = async (signal: FeedbackEvent["signal"]) => {
    setInteractionStatus(null);
    const ok = await onFeedback(item.projection, signal);
    setInteractionStatus(ok ? feedbackSuccessLabel(signal) : "That change did not go through. Try again.");
  };
  return (
    <article ref={cardRef} className="feed-card">
      <div className="card-meta">
        <span>{readablePostKind(item)}</span>
        <span>{readableFeedTime(item.projection.publishedAt)}</span>
      </div>
      {title && <h2><a href={`#/a/${encodeURIComponent(item.projection.feedItemId)}`}>{title}</a></h2>}
      {availability !== "available" && <p className="availability-message">{availabilityMessage(availability, Boolean(artifact))}</p>}
      {(item.projection.target.kind === "post" || item.projection.postBody) && (
        <>
          <p className="post-body">{item.projection.postBody ?? post?.body ?? (item.error
            ? "This post’s preview is temporarily unavailable."
            : "Loading this post…")}</p>
          {pullQuote && (
            <blockquote className="pull">
              <p>&ldquo;{pullQuote.quote}&rdquo;</p>
              <cite>
                {pullQuote.sourceRefId}
                {pullQuote.loc ? ` · ${pullQuote.loc}` : ""} · verified
              </cite>
            </blockquote>
          )}
        </>
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

// The local state a routine will hold once the intent is applied, so the UI
// can reflect it immediately. Returns the same reference for intents that
// don't change routine state (Run now, Ask Feed) so callers can skip the
// re-render. settingsVersion bumps optimistically to keep a fast second edit
// from tripping its own stale-version guard before the reload lands.
function optimisticWorkflow(
  workflow: FeedHostWorkflowState,
  intentKind: ControlIntentEvent["intentKind"],
  payload: Record<string, unknown>,
): FeedHostWorkflowState {
  const bumped = workflow.settingsVersion + 1;
  switch (intentKind) {
    case "pause_package":
      return { ...workflow, paused: true, settingsVersion: bumped };
    case "enable_package":
      return { ...workflow, paused: false, disabled: false, settingsVersion: bumped };
    case "disable_package":
      return { ...workflow, disabled: true, settingsVersion: bumped };
    case "reset_package":
      return { ...workflow, cadence: undefined, settings: undefined, settingsVersion: bumped };
    case "tune_package": {
      const settings = (payload.settings ?? {}) as Partial<RoutineDraft>;
      return {
        ...workflow,
        cadence: settings.cadence ?? workflow.cadence,
        settings: {
          sourceSelection: settings.sourceSelection ?? workflow.settings?.sourceSelection,
          audience: settings.audience ?? workflow.settings?.audience,
          outputVolume: settings.outputVolume ?? workflow.settings?.outputVolume,
        },
        settingsVersion: bumped,
      };
    }
    default:
      return workflow;
  }
}

function SkillCredentialsPanel({
  client,
  policy,
  actorId,
  onDisconnect,
  onReconnectRequired,
  attachInputAuthority,
}: {
  client: FeedV1HostClient;
  policy: FeedHostDelegationPolicy;
  actorId: string;
  onDisconnect: () => void;
  onReconnectRequired: (error: FeedReconnectRequiredError) => void;
  attachInputAuthority: typeof attachReceivedInputAuthority;
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
    // Optimistic: reflect the change locally right away so the control feels
    // instant, then post and reconcile in the background. A failed post
    // surfaces the error and a reload snaps state back to the server truth.
    const optimistic = optimisticWorkflow(workflow, intentKind, payload);
    if (optimistic !== workflow) {
      setWorkflows((current) =>
        current.map((entry) => (entry.packageId === workflow.packageId ? optimistic : entry)));
    }
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
      // Reconcile in the background — do not block the interaction on it.
      void reload();
    } catch (error) {
      setLoadError(formatHostError(error));
      void reload();
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
            void attachInputAuthority({ client, policy, sourceId, displayName, tc1Link })
              .then(() => {
                setNewSource({ sourceId: "", displayName: "", tc1Link: "" });
                return reload();
              })
              .catch((error) => {
                if (isFeedReconnectRequiredError(error)) {
                  onReconnectRequired(error);
                  return;
                }
                setLoadError(formatHostError(error));
              })
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
