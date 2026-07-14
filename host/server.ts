import type { DelegatedAccess, TinyCloudNode } from "@tinycloud/node-sdk";
import { createHash, timingSafeEqual } from "node:crypto";
import type {
  ControlIntentEvent,
  FeedArtifact,
  FeedbackEvent,
} from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import type { FeedControlIntentInput, FeedControlIntentKind, FeedGenerationRequestRecord } from "./logic.ts";
import {
  validateFeedTargetedInteractionEvent,
  type FeedInteractionTarget,
  type FeedTargetedInteractionEvent,
} from "../shared/feed-item.ts";
import { validateFeedArtifact } from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import { artifactIndexRow } from "../../artifactory/skills/_shared/lib/feed-v1-bootstrap.ts";
import {
  buildOpenApiDocument,
  buildServerInfo,
  createPolicyHash,
  FEED_HOST_PREFERENCES_SCOPE,
} from "./logic.ts";
import {
  activateFeedHostDelegation,
  actorIdsMatch,
  createFeedHostNode,
  createFeedHostPolicy,
  FeedDelegationError,
  FEED_HOST_ARTIFACT_DOC_PREFIX,
  FEED_HOST_ARTIFACTS_DB_PATH,
  FEED_HOST_FEED_DB_PATH,
  FEED_HOST_FEED_SETTINGS_PREFIX,
  hasCompleteFeedHostDelegation,
  normalizeActorId,
  validateInputAuthorityDelegation,
  type AcceptedFeedDelegation,
  type ActivatedFeedDelegation,
  type FeedHostDelegationPolicy,
} from "./delegation.ts";
import {
  LEGACY_FEED_DB_PATH,
  LEGACY_INTERACTIONS_DB_PATH,
} from "../../artifactory/skills/_shared/lib/feed-v1-migration.ts";
import { FeedHostDelegationStore, liveDelegationResources } from "./delegation-store.ts";
import { levelForStatus, logEvent } from "./log.ts";
import { ensureFeedHostPrivateKey } from "./host-key.ts";
import {
  InputAuthorityRegistry,
  type InputAuthorityInspector,
  type InputAuthorityRevoker,
  type InputAuthorityTruthCheck,
} from "./input-authority.ts";
import { seedDefaultFeed } from "./seed.ts";
import {
  FeedHostError,
  FeedHostStorage,
  type FeedHostActorStorage,
  type FeedHostSkillCredentialsPatch,
} from "./storage.ts";

type JsonBody = Record<string, unknown>;
type FeedbackRequestBody = Omit<FeedbackEvent, "actorId"> & { actorId?: string };
type ControlIntentRequestBody = Omit<ControlIntentEvent, "actorId"> & { actorId?: string };

export type FeedHostServerOptions = {
  port: number;
  hostname: string;
  token?: string;
  workerToken?: string;
  tinycloudHost?: string;
  hostPrivateKey?: string;
  seedOnStart?: boolean;
  storage?: FeedHostStorage;
  hostNode?: TinyCloudNode;
  enableDevPublisher?: boolean;
  delegationStore?: FeedHostDelegationStore | null;
  activateDelegation?: (input: {
    serializedDelegation: string;
    expectedDelegateDID: string;
  }) => Promise<ActivatedFeedDelegation>;
  inspectInputAuthority?: InputAuthorityInspector;
  checkInputAuthority?: InputAuthorityTruthCheck;
  revokeInputAuthority?: InputAuthorityRevoker;
  inputAuthorityExpectedHost?: string;
  requireActorSession?: boolean;
  allowedOrigins?: string[];
};

export type FeedHostRuntime = {
  hostname: string;
  port: number;
  url: string;
  stop: () => void;
};

type ActorState = AcceptedFeedDelegation & {
  accessByResource: Map<string, DelegatedAccess>;
  storageAccess?: FeedHostActorStorage;
  ready?: Promise<void>;
  preparation?: ActorPreparationStatus;
  expiresAt: string;
};

type ActorPreparationPhase = "idle" | "bootstrap" | "artifact_check" | "seed" | "reconcile" | "ready" | "failed";

type ActorPreparationStatus = {
  state: "not_started" | "preparing" | "ready" | "failed";
  phase: ActorPreparationPhase;
  attempt: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: { code: "preparation_failed"; message: string };
};

type FeedHostContext = {
  storage: FeedHostStorage;
  policy: FeedHostDelegationPolicy;
  policyHash: string;
  serverInfo: ReturnType<typeof buildServerInfo>;
  actors: Map<string, ActorState>;
  activateDelegation: NonNullable<FeedHostServerOptions["activateDelegation"]>;
  seedOnStart: boolean;
  delegationStore: FeedHostDelegationStore | null;
  enableDevPublisher: boolean;
  inputAuthorities: InputAuthorityRegistry;
  inspectInputAuthority: InputAuthorityInspector;
  checkInputAuthority: InputAuthorityTruthCheck;
  revokeInputAuthority: InputAuthorityRevoker;
  inputAuthorityExpectedHost: string;
  requireActorSession: boolean;
  actorSessions: Map<string, { actorKey: string; expiresAt: string; policyHash: string }>;
  actorRequestQueues: Map<string, Promise<void>>;
};

const PUBLIC_PATHS = new Set([
  "/health",
  "/delegation-policy",
  "/api/server-info",
  "/api/openapi.json",
]);

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, X-Feed-Actor-Id, If-None-Match, Last-Event-ID",
};

const JSON_HEADERS = {
  ...CORS_HEADERS,
  "content-type": "application/json",
};

const FEEDBACK_NOTE_MAX_CHARS = 1024;
const TINYCLOUD_TRANSACTION_RETRY_DELAYS_MS = [250, 750, 1500, 3000, 6000];
const MAX_ACTOR_SESSIONS = 5;
const MIN_WORKER_TOKEN_BYTES = 32;
const DEFAULT_WORKER_LEASE_SECONDS = 120;
const DEFAULT_WORKER_MAX_ATTEMPTS = 3;

const SSE_HEADERS = {
  ...CORS_HEADERS,
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

type InputAuthorityVerificationNode = Pick<TinyCloudNode, "useDelegation"> & {
  computeDelegationCid?: (authorization: string) => string;
  getDelegationStatus?: (cid: string) => Promise<{
    ok: boolean;
    data?: { cid: string; status: string; active: boolean };
  }>;
};

export function createInputAuthorityInspector(hostNode: InputAuthorityVerificationNode): InputAuthorityInspector {
  return async (input) => {
    if (!hostNode.computeDelegationCid || !hostNode.getDelegationStatus) {
      throw new FeedHostError("TinyCloud input-authority verification is unavailable", 503, "input_authority_unavailable");
    }
    const inspected = validateInputAuthorityDelegation({
      serializedDelegation: input.portableDelegation,
      expectedDelegateDID: input.expectedAudienceDID,
      expectedHost: input.expectedHost,
      computeDelegationCid: (authorization) => hostNode.computeDelegationCid!(authorization),
    });
    // Activate the recomputed, identity-bound token so the node can sign the
    // target-status request. No caller-supplied activation metadata is trusted.
    await hostNode.useDelegation(inspected.portableDelegation);
    const status = await hostNode.getDelegationStatus(inspected.childCid);
    if (!status.ok || status.data?.cid !== inspected.childCid || status.data.status !== "active" || !status.data.active) {
      throw new FeedHostError("TinyCloud did not confirm an active input authority", 409, "input_authority_unavailable");
    }
    const { portableDelegation: _portableDelegation, ...lineage } = inspected;
    return lineage;
  };
}

export function startFeedHost(options: FeedHostServerOptions): FeedHostRuntime {
  const storage = options.storage ?? new FeedHostStorage();
  const hostNode =
    options.hostNode ?? createFeedHostNode({ privateKey: options.hostPrivateKey, host: options.tinycloudHost });
  // A stable host key lets the host re-activate persisted delegations after
  // restart. Without one, the host can still serve a live session but cannot
  // restore old delegates from its KV store.
  const hostReady: Promise<void> = options.hostPrivateKey ? hostNode.signIn() : Promise.resolve();
  hostReady.catch((error) => {
    console.error("Feed Host TinyCloud sign-in failed:", error instanceof Error ? error.message : error);
  });
  const activateDelegation =
    options.activateDelegation ??
    ((input) =>
      activateFeedHostDelegation({
        node: hostNode,
        serializedDelegation: input.serializedDelegation,
        expectedDelegateDID: input.expectedDelegateDID,
      }));
  const delegationStore =
    options.delegationStore !== undefined
      ? options.delegationStore
      : options.hostPrivateKey
        ? new FeedHostDelegationStore(hostNode)
        : null;
  const actors = new Map<string, ActorState>();
  const actorRequestQueues = new Map<string, Promise<void>>();
  const inputAuthorities = new InputAuthorityRegistry();
  const inspectInputAuthority = options.inspectInputAuthority ?? createInputAuthorityInspector(hostNode);
  const checkInputAuthority: InputAuthorityTruthCheck = options.checkInputAuthority ?? (async ({ childCid }) => {
    const authorityNode = hostNode as TinyCloudNode & {
      getDelegationStatus?: (cid: string) => Promise<{ ok: boolean; data?: { cid: string; status: string } }>;
    };
    if (!authorityNode.getDelegationStatus) return "unavailable";
    const result = await authorityNode.getDelegationStatus(childCid);
    if (!result.ok || result.data?.cid !== childCid) return "unavailable";
    if (result.data.status === "active" || result.data.status === "revoked" || result.data.status === "expired") {
      return result.data.status;
    }
    return "unavailable";
  });
  const revokeInputAuthority: InputAuthorityRevoker = options.revokeInputAuthority ?? (async ({ childCid }) => {
    const result = await hostNode.revokeDelegation(childCid);
    return result.ok;
  });
  let context: FeedHostContext | null = null;

  const getContext = async (): Promise<FeedHostContext> => {
    await hostReady;
    const policy = createFeedHostPolicy(hostNode.did);
    context ??= {
      storage,
      policy,
      policyHash: createPolicyHash(policy),
      serverInfo: buildServerInfo(policy),
      actors,
      activateDelegation,
      seedOnStart: options.seedOnStart !== false,
      delegationStore,
      enableDevPublisher: options.enableDevPublisher === true,
      inputAuthorities,
      inspectInputAuthority,
      checkInputAuthority,
      revokeInputAuthority,
      inputAuthorityExpectedHost: options.inputAuthorityExpectedHost ?? options.tinycloudHost ?? "https://node.tinycloud.xyz",
      requireActorSession: options.requireActorSession !== false,
      actorSessions: new Map(),
      actorRequestQueues,
    };
    return context;
  };

  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    // TinyCloud round-trips can exceed Bun's default idle timeout.
    idleTimeout: 120,
    maxRequestBodySize: 1024 * 1024,
    async fetch(request) {
      const url = new URL(request.url);
      const workerRoute = isWorkerRoute(url.pathname);
      const privateRoute = requiresActorSession(request, url);
      const noStoreRoute = workerRoute || privateRoute || url.pathname === "/delegation-policy" || url.pathname === "/api/delegations";
      const finish = (response: Response) => {
        const finished = applyResponsePolicy(
          response,
          request,
          options.allowedOrigins,
          noStoreRoute,
          options.requireActorSession !== false,
        );
        if (!workerRoute) return finished;
        const headers = new Headers(finished.headers);
        for (const name of [...headers.keys()]) {
          if (name.startsWith("access-control-")) headers.delete(name);
        }
        return new Response(finished.body, { status: finished.status, statusText: finished.statusText, headers });
      };
      if (workerRoute && request.headers.has("origin")) {
        return finish(jsonError(403, "origin_denied", "worker API does not accept browser requests"));
      }
      if (!workerRoute && !isAllowedOrigin(request, options.allowedOrigins, options.requireActorSession !== false)) {
        return finish(jsonError(403, "origin_denied", "browser origin is not allowed"));
      }
      if (!workerRoute && request.method === "OPTIONS") {
        return finish(new Response(null, { status: 204, headers: CORS_HEADERS }));
      }

      const startedAt = performance.now();
      let authenticatedActor: string | undefined;
      const logRequest = (response: Response, errorCode?: string, error?: unknown) => {
        const finished = finish(response);
        if (request.method === "GET" && PUBLIC_PATHS.has(url.pathname)) return finished;
        logEvent(levelForStatus(response.status), "http_request", {
          method: request.method,
          path: url.pathname,
          status: response.status,
          ms: Math.round(performance.now() - startedAt),
          actor: authenticatedActor,
          ...(errorCode ? { code: errorCode } : {}),
          ...(error ? errorLogFields(error) : {}),
        });
        return finished;
      };

      const publicRoute = PUBLIC_PATHS.has(url.pathname);
      if (workerRoute && !workerAuthorized(request, options.workerToken)) {
        return logRequest(jsonError(401, "unauthorized", "missing or invalid worker bearer token"), "unauthorized");
      }
      if (!workerRoute && !publicRoute && !authorized(request, options.token)) {
        return logRequest(jsonError(401, "unauthorized", "missing or invalid bearer token"), "unauthorized");
      }

      try {
        const currentContext = await getContext();
        let routedRequest = request;
        if (privateRoute && currentContext.requireActorSession) {
          authenticatedActor = authenticatedSessionActor(request, currentContext);
          if (!authenticatedActor) {
            return logRequest(jsonError(401, "unauthorized", "missing or invalid actor session"), "unauthorized");
          }
          routedRequest = bindAuthenticatedActor(request, authenticatedActor);
        }
        const runRoute = () => workerRoute
          ? routeWorker(request, currentContext, actorRequestQueues)
          : request.method === "GET" && authenticatedActor
          ? retryTinyCloudTransaction("route_read", authenticatedActor, () => route(routedRequest, currentContext))
          : route(routedRequest, currentContext);
        const response = authenticatedActor && !isActorControlRoute(request.method, url.pathname)
          ? await serializeActorRequest(actorRequestQueues, authenticatedActor, runRoute)
          : await runRoute();
        return logRequest(response);
      } catch (error) {
        const errorCode =
          error instanceof FeedHostError ? error.code : error instanceof FeedDelegationError ? error.code : "internal_error";
        return logRequest(mapError(error, url.pathname), errorCode, error);
      }
    },
  });

  const stop = () => {
    server.stop(true);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const hostname = server.hostname ?? options.hostname;
  const port = server.port ?? options.port;
  return {
    hostname,
    port,
    url: `http://${hostname}:${port}`,
    stop,
  };
}

async function route(request: Request, context: FeedHostContext): Promise<Response> {
  const {
    storage,
    policy,
    policyHash,
    serverInfo,
    actors,
    activateDelegation,
    seedOnStart,
    delegationStore,
    inputAuthorities,
    inspectInputAuthority,
    checkInputAuthority,
    revokeInputAuthority,
    inputAuthorityExpectedHost,
  } = context;
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      serviceReady: true,
      authorityReady: actors.size > 0,
      schema: "tinycloud.sql/schema",
      storage: "tinycloud",
      delegateDID: policy.delegateDID,
      policyHash,
      actors: actors.size,
    });
  }

  if (request.method === "GET" && url.pathname === "/delegation-policy") {
    return json(policy);
  }

  if (request.method === "GET" && url.pathname === "/api/server-info") {
    const etag = quotedEtag(policyHash);
    if (etagMatches(request.headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: { ...CORS_HEADERS, etag } });
    }
    return json(serverInfo, 200, { etag, "cache-control": "public, max-age=60, must-revalidate" });
  }

  if (request.method === "GET" && url.pathname === "/api/openapi.json") {
    return json(buildOpenApiDocument(serverInfo));
  }

  if (request.method === "GET" && url.pathname === "/api/delegations/status") {
    const actorId = requireRequestActorId(request);
    return json(await readDelegationStatus(context, actorId));
  }

  if (request.method === "POST" && url.pathname === "/api/delegations/retry") {
    const actorId = requireRequestActorId(request);
    const actor = await requireDelegation(context, actorId);
    if (actor.preparation?.state === "failed") actor.ready = undefined;
    void ensureActorReady(storage, actor, seedOnStart).catch(() => undefined);
    const setup = actorPreparationSnapshot(actor);
    logEvent("info", "feed_preparation_retry_requested", {
      actor: actor.actorId,
      attempt: setup.attempt,
      phase: setup.phase,
    });
    return json({ accepted: true, actorId: actor.actorId, setup }, setup.state === "ready" ? 200 : 202);
  }

  if (request.method === "DELETE" && url.pathname === "/api/delegations") {
    const actorId = requireRequestActorId(request);
    await removeDelegation(context, actorId);
    return new Response(null, {
      status: 204,
      headers: { ...CORS_HEADERS, "set-cookie": clearedActorSessionCookie(request) },
    });
  }

  if (request.method === "POST" && url.pathname === "/api/delegations") {
    const body = await readJsonObject(request, "invalid_delegation", "delegation body must be JSON");
    const serializedDelegation = readString(body, "serializedDelegation", "invalid_delegation", "serializedDelegation is required");
    const payloadActorId = optionalString(body.actorId);
    const activationStartedAt = performance.now();
    const activated = await retryTinyCloudTransaction(
      "delegation_activate",
      undefined,
      () => activateDelegation({
        serializedDelegation,
        expectedDelegateDID: policy.delegateDID,
      }),
    ).catch((error) => {
      if (error instanceof FeedDelegationError) {
        if (error.code === "malformed") throw new FeedHostError(error.message, 400, "invalid_delegation");
        if (error.code === "expired" || error.code === "delegation_stale") {
          throw new FeedHostError(error.message, 409, "delegation_stale");
        }
        if (error.code === "wrong_delegatee" || error.code === "insufficient_policy" || error.code === "actor_mismatch") {
          throw new FeedHostError(error.message, 403, "denied");
        }
      }
      throw error;
    });
    logEvent("info", "feed_delegation_activated", {
      actor: activated.actorId,
      ms: Math.round(performance.now() - activationStartedAt),
      resources: activated.resources.length,
    });
    if (payloadActorId && !actorIdsMatch(payloadActorId, activated.actorId)) {
      throw new FeedHostError("actorId does not match the delegation owner identity", 403, "actor_mismatch");
    }

    return serializeActorRequest(context.actorRequestQueues, activated.actorId, async () => {
      const actorKey = normalizeActorId(activated.actorId);
      const prior = actors.get(actorKey);
      const existing = prior && !isDelegationExpired(prior) ? prior : undefined;
      const currentProofComplete = policy.resources.every((resource) => activated.resources.includes(resource.path));
      const resources = currentProofComplete
        ? [...activated.resources]
        : [...new Set([...(existing?.resources ?? []), ...activated.resources])];
      const accessByResource = new Map(currentProofComplete ? undefined : existing?.accessByResource);
      for (const resource of activated.resources) accessByResource.set(resource, activated.access);
      const state: ActorState = {
        actorId: activated.actorId,
        acceptedAt: activated.acceptedAt,
        expiresAt: currentProofComplete ? activated.expiresAt : earliestExpiry(existing?.expiresAt, activated.expiresAt),
        resources,
        accessByResource,
        storageAccess: currentProofComplete ? undefined : existing?.storageAccess,
        ready: currentProofComplete ? undefined : existing?.ready,
        preparation: currentProofComplete ? undefined : existing?.preparation,
      };
      const actor = currentProofComplete && hasCompleteFeedHostDelegation(existing) && existing?.ready
        ? existing
        : state;
      if (currentProofComplete || !hasCompleteFeedHostDelegation(existing)) actors.set(actorKey, actor);
      if (delegationStore && (currentProofComplete || !hasCompleteFeedHostDelegation(existing))) {
        const persistenceStartedAt = performance.now();
        void retryTinyCloudTransaction(
          "delegation_persist",
          activated.actorId,
          () => persistAcceptedDelegation(delegationStore, policy, policyHash, actorKey, {
            serializedDelegation,
            resources: activated.resources,
            acceptedAt: activated.acceptedAt,
            expiresAt: activated.expiresAt,
          }),
        ).then(() => {
          logEvent("info", "feed_delegation_persisted", {
            actor: activated.actorId,
            ms: Math.round(performance.now() - persistenceStartedAt),
          });
        }).catch((error) => {
          logEvent("warn", "feed_delegation_persist_failed", {
            actor: activated.actorId,
            ms: Math.round(performance.now() - persistenceStartedAt),
            ...errorLogFields(error),
          });
        });
      }
      if (!currentProofComplete) {
        return json({
          accepted: true,
          actorId: activated.actorId,
          resources: activated.resources,
          policyHash,
          status: "activation_pending",
        }, 202);
      }
      void ensureActorReady(storage, actor, seedOnStart).catch(() => undefined);
      const setup = actorPreparationSnapshot(actor);
      const sessionToken = issueActorSession(context, actorKey, actor.expiresAt);
      return json({
        accepted: true,
        actorId: activated.actorId,
        resources: actor.resources,
        policyHash,
        status: setup.state === "ready" ? "active" : "preparing",
        setup,
      }, setup.state === "ready" ? 200 : 202, {
        "set-cookie": actorSessionCookie(sessionToken, request, actor.expiresAt),
        "cache-control": "private, no-store",
      });
    });
  }

  if (url.pathname === "/input-authorities" && request.method === "GET") {
    const actor = await requireCompleteActor(request, context);
    return json({ items: await inputAuthorities.list(actorStorage(actor), checkInputAuthority) });
  }

  if (url.pathname === "/input-authorities" && request.method === "POST") {
    const actor = await requireCompleteActor(request, context);
    const body = await readJsonObject(request, "invalid_input_authority", "input authority body must be JSON");
    const item = await inputAuthorities.attach({
      actor: actorStorage(actor),
      body,
      expectedAudienceDID: policy.delegateDID,
      expectedHost: inputAuthorityExpectedHost,
      inspect: inspectInputAuthority,
    });
    return json({ attached: true, item }, 201);
  }

  const inputAuthorityMatch = url.pathname.match(/^\/input-authorities\/([^/]+)(?:\/(status|revoke))?$/);
  if (inputAuthorityMatch) {
    const actor = await requireCompleteActor(request, context);
    const sourceId = decodeURIComponent(inputAuthorityMatch[1]);
    const action = inputAuthorityMatch[2];
    if (request.method === "GET" && action === undefined) {
      return json(await inputAuthorities.get(actorStorage(actor), sourceId, checkInputAuthority));
    }
    if (request.method === "GET" && action === "status") {
      const item = await inputAuthorities.get(actorStorage(actor), sourceId, checkInputAuthority);
      return json({ sourceId: item.sourceId, state: item.state, expiry: item.expiry, revokedAt: item.revokedAt });
    }
    if (request.method === "POST" && action === "revoke") {
      return json({ revoked: true, item: await inputAuthorities.revoke(actorStorage(actor), sourceId, revokeInputAuthority) });
    }
    if (request.method === "DELETE" && action === undefined) {
      await inputAuthorities.remove(actorStorage(actor), sourceId);
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
  }

  // Browser-side failures (sign-in, delegation minting, feed setup) happen
  // before any delegation exists, so this ingestion route needs no actor —
  // it only feeds the structured log stream. Input is tightly bounded.
  if (request.method === "POST" && url.pathname === "/api/client-events") {
    const body = await readJsonObject(request, "invalid_client_event", "client event body must be JSON");
    const entries = Array.isArray(body.events) ? body.events.slice(0, 20) : [body];
    let accepted = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const eventName = optionalString(record.event);
      if (!eventName) continue;
      const level = record.level === "error" || record.level === "warn" ? record.level : "info";
      logEvent(level, `client_${eventName.slice(0, 64)}`, {
        source: "web",
        ...(optionalString(record.detail) ? { detail: optionalString(record.detail)!.slice(0, 500) } : {}),
      });
      accepted += 1;
    }
    return json({ accepted });
  }

  if (request.method === "GET" && url.pathname === "/admin/state") {
    const actor = await requireCompleteActor(request, context);
    return json(await storage.debugState(actorStorage(actor)));
  }

  if (request.method === "POST" && url.pathname === "/admin/seed") {
    const actor = await requireCompleteActor(request, { ...context, seedOnStart: false });
    await seedDefaultFeed(storage, actorStorage(actor));
    await storage.reconcileFeedProjection(actorStorage(actor));
    return json({ ok: true, state: await storage.debugState(actorStorage(actor)) });
  }

  if (request.method === "POST" && url.pathname === "/admin/dev/publish-artifact") {
    if (!context.enableDevPublisher) {
      throw new FeedHostError("dev artifact publishing is disabled", 404, "not_found");
    }
    const actor = await requireDevPublisherActor(request, context);
    const body = await readJsonObject(request, "invalid_artifact", "artifact body must be JSON");
    const artifact = normalizeDevPublishArtifact(body);
    const access = actorStorage(actor);
    await storage.writeArtifactDocument(access, artifact);
    await storage.insertSeedRows(access, "artifacts_index", [artifactIndexRow(artifact)]);
    await storage.reconcileFeedProjection(access);
    logEvent("info", "artifact_published", {
      artifactId: artifact.artifactId,
      artifactType: artifact.artifactType,
      packageId: artifact.producedBy.packageId,
      runId: artifact.producedBy.runId,
      actor: actor.actorId,
      via: "dev_publisher",
    });
    return json({
      accepted: true,
      artifactId: artifact.artifactId,
      state: await storage.debugState(access),
    });
  }

  if (request.method === "GET" && url.pathname === "/admin/dev/generation-requests") {
    if (!context.enableDevPublisher) {
      throw new FeedHostError("dev generation endpoints are disabled", 404, "not_found");
    }
    const actor = await requireDevPublisherActor(request, context);
    const limit = parseLimit(url.searchParams.get("limit"));
    const status = optionalString(url.searchParams.get("status"));
    const items = await storage.listGenerationRequests(actorStorage(actor), limit, {
      status,
      excludeExpired: status !== undefined,
      order: "asc",
    });
    return json({ items: items.map(normalizeGenerationRequestRecord) });
  }

  const generationStatusMatch = url.pathname.match(/^\/admin\/dev\/generation-requests\/([^/]+)\/status$/);
  if (request.method === "POST" && generationStatusMatch) {
    if (!context.enableDevPublisher) {
      throw new FeedHostError("dev generation endpoints are disabled", 404, "not_found");
    }
    const actor = await requireDevPublisherActor(request, context);
    const requestId = decodeURIComponent(generationStatusMatch[1]);
    const body = await readJsonObject(request, "invalid_generation_status", "status body must be JSON");
    const status = readGenerationRequestStatus(body.status);
    const expectedStatus = body.expectedStatus === undefined ? undefined : readGenerationRequestStatus(body.expectedStatus);
    const record = await storage.updateGenerationRequestStatus(actorStorage(actor), {
      requestId,
      status,
      expectedStatus,
      updatedAt: new Date().toISOString(),
    });
    logEvent("info", "generation_request_status", {
      requestId,
      status,
      expectedStatus,
      actor: actor.actorId,
      note: optionalString(body.note),
    });
    return json({ updated: true, request: record });
  }

  if (request.method === "GET" && url.pathname === "/feed") {
    const actor = await requireCompleteActor(request, context);
    try {
      await storage.reconcileFeedProjection(actorStorage(actor));
    } catch (error) {
      logEvent("warn", "feed_reconcile_degraded", {
        actor: actor.actorId,
        ...errorLogFields(error),
      });
    }
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (cursor !== undefined && cursor !== "" && !/^\d+$/.test(cursor)) {
      throw new FeedHostError("cursor must be a non-negative integer offset", 400, "bad_request");
    }
    return json(await storage.listFeed(actorStorage(actor), { limit, cursor }));
  }

  if (request.method === "GET" && url.pathname === "/feed/events") {
    const actor = await requireCompleteActor(request, context);
    const body = await storage.listFeedEvents(actorStorage(actor), optionalString(request.headers.get("last-event-id")));
    return new Response(body, { status: 200, headers: SSE_HEADERS });
  }

  const artifactMatch = url.pathname.match(/^\/artifacts\/([^/]+)(\/provenance)?$/);
  if (request.method === "GET" && artifactMatch) {
    const actor = await requireCompleteActor(request, context);
    const artifactId = decodeURIComponent(artifactMatch[1]);
    const result = await storage.readArtifact(actorStorage(actor), artifactId);
    if (result.kind === "not_found") {
      return json({ error: { code: "not_found", message: `artifact not found: ${artifactId}` } }, 404);
    }
    if (result.kind === "hydration_failed") {
      return json({ error: { code: "hydration_failed", message: `artifact hydration failed: ${artifactId}` } }, 424);
    }
    if (artifactMatch[2]) {
      return json({
        artifactId: result.artifact.artifactId,
        sourceRefs: result.artifact.sourceRefs,
        producedBy: result.artifact.producedBy,
        freshness: result.artifact.freshness,
        idempotency: result.artifact.idempotency,
      });
    }
    return json(result.artifact);
  }

  if (request.method === "GET" && url.pathname === "/preferences") {
    const actor = await requireCompleteActor(request, context);
    const scope = optionalString(url.searchParams.get("scope")) ?? undefined;
    const profile = await storage.readPreferenceProfile(actorStorage(actor), scope);
    return json({ profile });
  }

  if (request.method === "PUT" && url.pathname === "/preferences") {
    const body = await readJsonObject(request, "invalid_preferences", "preference body must be JSON");
    const actorId = requireRequestActorId(request);
    const bodyActorId = optionalString(body.actorId);
    if (body.actorId !== undefined && (!bodyActorId || !actorIdsMatch(bodyActorId, actorId))) {
      throw new FeedHostError("actorId does not match the request actor", 403, "actor_mismatch");
    }
    const actor = await requireDelegationAndReady(context, actorId);
    const scope = optionalString(body.scope) ?? undefined;
    if (scope !== undefined && scope !== FEED_HOST_PREFERENCES_SCOPE) {
      throw new FeedHostError("preference scope is not allowlisted", 400, "invalid_preferences");
    }
    const expectedVersion = optionalNumber(body.expectedVersion);
    const patch = optionalObject(body.patch);
    const reset = optionalBoolean(body.reset);
    const record = await storage.putPreferenceProfile(actorStorage(actor), {
      actorId,
      scope,
      expectedVersion,
      patch: patch as never,
      reset,
      updatedAt: typeof body.updatedAt === "string" ? body.updatedAt : undefined,
    });
    return json({ profile: record });
  }

  if (request.method === "GET" && url.pathname === "/generation-requests") {
    const actor = await requireCompleteActor(request, context);
    const limit = parseLimit(url.searchParams.get("limit"));
    const items = await storage.listGenerationRequests(actorStorage(actor), limit);
    return json({ items: items.map(normalizeGenerationRequestRecord) });
  }

  const generationCancelMatch = url.pathname.match(/^\/generation-requests\/([^/]+)\/cancel$/);
  if (request.method === "POST" && generationCancelMatch) {
    const actor = await requireCompleteActor(request, context);
    const requestId = decodeURIComponent(generationCancelMatch[1]);
    const record = await storage.requestGenerationCancellation(actorStorage(actor), {
      requestId,
      now: new Date().toISOString(),
    });
    logEvent("info", "generation_request_cancellation", {
      requestId,
      status: record.status,
      phase: record.phase,
      actor: actor.actorId,
    });
    return json({ cancellationRequested: record.cancellationRequested, request: record });
  }

  if (request.method === "GET" && url.pathname === "/control-intents") {
    const actor = await requireCompleteActor(request, context);
    const limit = parseLimit(url.searchParams.get("limit"));
    const items = await storage.listControlIntents(actorStorage(actor), limit);
    return json({ items: items.map(normalizeControlIntentRecord) });
  }

  if (request.method === "POST" && url.pathname === "/feedback") {
    const body = await readJsonObject(request, "invalid_feedback", "feedback body must be JSON");
    const actorId = resolveRequestActorId(request, body.actorId);
    const actor = await requireDelegationAndReady(context, actorId);
    const event = normalizeFeedbackEvent(body, actorId);
    const result = await storage.recordFeedback(actorStorage(actor), event);
    return json(
      {
        accepted: true,
        eventId: result.eventId,
        duplicate: result.duplicate,
        status: result.status,
      },
      200,
    );
  }

  if (request.method === "POST" && url.pathname === "/control-intents") {
    const body = await readJsonObject(request, "invalid_intent", "control intent body must be JSON");
    const actorId = resolveRequestActorId(request, body.actorId);
    const actor = await requireDelegationAndReady(context, actorId);
    const event = normalizeControlIntentEvent(body, actorId);
    const result = await storage.recordControlIntent(actorStorage(actor), event);
    if (result.requestId && !result.duplicate) {
      logEvent("info", "generation_request_accepted", {
        requestId: result.requestId,
        intentKind: event.intentKind,
        actor: actorId,
      });
    }
    return json(
      {
        accepted: true,
        eventId: result.eventId,
        duplicate: result.duplicate,
        status: result.status,
        requestId: result.requestId,
      },
      result.status === "accepted" ? 202 : 200,
    );
  }

  if (request.method === "GET" && url.pathname === "/skills") {
    const actor = await requireCompleteActor(request, context);
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (cursor !== undefined && cursor !== "" && !/^\d+$/.test(cursor)) {
      throw new FeedHostError("cursor must be a non-negative integer offset", 400, "bad_request");
    }
    return json(
      await storage.listSkills(actorStorage(actor), {
        actorId: actor.actorId,
        limit,
        cursor,
      }),
    );
  }

  const skillCredentialsMatch = url.pathname.match(/^\/skills\/([^/]+)\/credentials$/);
  if (request.method === "PATCH" && skillCredentialsMatch) {
    const actor = await requireCompleteActor(request, context);
    const skillId = decodeURIComponent(skillCredentialsMatch[1]);
    const body = await readJsonObject(request, "invalid_skill_credentials", "credentials body must be JSON");
    const patch = normalizeSkillCredentialsPatch(body);
    const skill = await storage.upsertSkillCredentials(actorStorage(actor), {
      actorId: actor.actorId,
      skillId,
      patch,
    });
    return json({ updated: true, skill });
  }

  return json({ error: { code: "not_found", message: `${request.method} ${url.pathname}` } }, 404);
}

async function routeWorker(
  request: Request,
  context: FeedHostContext,
  actorRequestQueues: Map<string, Promise<void>>,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST") {
    throw new FeedHostError("worker control endpoints require POST", 405, "method_not_allowed");
  }
  const body = await readJsonObject(request, "invalid_worker_request", "worker request body must be JSON");
  const actorId = readString(body, "actorId", "invalid_worker_request", "actorId is required");
  return serializeActorRequest(actorRequestQueues, actorId, async () => {
    const actor = await requireDelegationAndReady(context, actorId);
    const access = actorStorage(actor);
    const now = new Date().toISOString();

  if (url.pathname === "/api/worker/generation-requests/claim") {
    const workflowId = readString(body, "workflowId", "invalid_worker_request", "workflowId is required");
    const claimOwner = readString(body, "claimOwner", "invalid_worker_request", "claimOwner is required");
    const leaseSeconds = boundedInteger(body.leaseSeconds, DEFAULT_WORKER_LEASE_SECONDS, 15, 900);
    const maxAttempts = boundedInteger(body.maxAttempts, DEFAULT_WORKER_MAX_ATTEMPTS, 1, 10);
    const requestRecord = await context.storage.claimGenerationRequest(access, {
      workflowId,
      claimOwner,
      now,
      leaseExpiresAt: new Date(Date.parse(now) + leaseSeconds * 1000).toISOString(),
      maxAttempts,
    });
    if (requestRecord) {
      logEvent("info", "generation_request_claimed", {
        requestId: requestRecord.requestId,
        runId: requestRecord.runId,
        claimOwner: requestRecord.claimOwner,
        fencingToken: requestRecord.fencingToken,
        attemptCount: requestRecord.attemptCount,
        actor: actor.actorId,
      });
    }
    return json({ request: requestRecord, committedCursor: requestRecord?.sourceCursorBefore ?? null });
  }

  const match = url.pathname.match(
    /^\/api\/worker\/generation-requests\/([^/]+)\/(heartbeat|phase|artifacts|reconcile|complete|retry|assert)$/,
  );
  if (!match) throw new FeedHostError("worker endpoint not found", 404, "not_found");
  const requestId = decodeURIComponent(match[1]);
  const action = match[2];
  const identity = {
    requestId,
    runId: readString(body, "runId", "invalid_worker_request", "runId is required"),
    claimOwner: readString(body, "claimOwner", "invalid_worker_request", "claimOwner is required"),
    fencingToken: boundedInteger(body.fencingToken, -1, 1, Number.MAX_SAFE_INTEGER),
    now,
  };

  if (action === "heartbeat") {
    const leaseSeconds = boundedInteger(body.leaseSeconds, DEFAULT_WORKER_LEASE_SECONDS, 15, 900);
    const record = await context.storage.heartbeatGenerationRequest(access, {
      ...identity,
      leaseExpiresAt: new Date(Date.parse(now) + leaseSeconds * 1000).toISOString(),
    });
    return json({ request: record });
  }
  if (action === "phase") {
    const phase = readWorkerPhase(body.phase);
    const record = await context.storage.updateGenerationRequestPhase(access, {
      ...identity,
      phase,
      metadata: readWorkerMetadata(body.metadata),
    });
    return json({ request: record });
  }
  if (action === "artifacts") {
    const result = await context.storage.publishGenerationArtifacts(access, {
      ...identity,
      publicationKey: optionalString(body.publicationKey),
      artifacts: Object.hasOwn(body, "artifacts") ? readWorkerArtifacts(body.artifacts) : undefined,
      timingEvents: readWorkerTimingEvents(body.timingEvents),
    });
    return json(result);
  }
  if (action === "reconcile") {
    return json(await context.storage.reconcileGenerationRequest(access, identity));
  }
  if (action === "assert") {
    return json({ request: await context.storage.assertGenerationRequestFence(access, identity) });
  }
  if (action === "complete") {
    if (!Object.hasOwn(body, "cursor")) {
      throw new FeedHostError("cursor is required", 400, "invalid_worker_request");
    }
    const record = await context.storage.completeGenerationRequest(access, {
      ...identity,
      outcome: readWorkerOutcome(body.outcome),
      cursor: body.cursor,
      artifactIds: readStringArray(body.artifactIds, "artifactIds"),
      timingEvents: readWorkerTimingEvents(body.timingEvents),
    });
    return json({ request: record });
  }

  const retryAfterSeconds = boundedInteger(body.retryAfterSeconds, 60, 1, 86_400);
  const errorCode = readWorkerErrorCode(body.errorCode);
  const record = await context.storage.retryGenerationRequest(access, {
    ...identity,
    nextRetryAt: new Date(Date.parse(now) + retryAfterSeconds * 1000).toISOString(),
    retryable: optionalBoolean(body.retryable) ?? true,
    error: { code: errorCode, message: optionalString(body.errorMessage) },
    timingEvents: readWorkerTimingEvents(body.timingEvents),
  });
  logEvent("warn", "generation_request_retry", {
    requestId,
    runId: identity.runId,
    claimOwner: identity.claimOwner,
    fencingToken: identity.fencingToken,
    attemptCount: record.attemptCount,
    status: record.status,
    errorCode,
    actor: actor.actorId,
  });
    return json({ request: record });
  });
}

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return true;
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function isWorkerRoute(pathname: string): boolean {
  return pathname === "/api/worker/generation-requests/claim" || pathname.startsWith("/api/worker/generation-requests/");
}

function workerAuthorized(request: Request, configuredToken: string | undefined): boolean {
  if (!configuredToken || Buffer.byteLength(configuredToken, "utf8") < MIN_WORKER_TOKEN_BYTES) return false;
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const expectedDigest = createHash("sha256").update(configuredToken).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}

function isAllowedOrigin(request: Request, allowedOrigins: string[] | undefined, requireActorSession: boolean): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  if (!allowedOrigins) return !requireActorSession;
  return allowedOrigins.includes(origin);
}

function applyResponsePolicy(
  response: Response,
  request: Request,
  allowedOrigins: string[] | undefined,
  privateRoute: boolean,
  requireActorSession: boolean,
): Response {
  const headers = new Headers(response.headers);
  if (allowedOrigins || requireActorSession) {
    headers.delete("access-control-allow-origin");
    const origin = request.headers.get("origin");
    if (origin && allowedOrigins?.includes(origin)) {
      headers.set("access-control-allow-origin", origin);
      headers.set("access-control-allow-credentials", "true");
      headers.append("vary", "Origin");
    }
  }
  if (privateRoute) headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function requiresActorSession(request: Request, url: URL): boolean {
  if (isWorkerRoute(url.pathname)) return false;
  if (PUBLIC_PATHS.has(url.pathname)) return false;
  if (request.method === "POST" && (url.pathname === "/api/delegations" || url.pathname === "/api/client-events")) {
    return false;
  }
  return true;
}

function isActorControlRoute(method: string, pathname: string): boolean {
  return pathname === "/api/delegations/status" || (method === "POST" && pathname === "/api/delegations/retry");
}

function authenticatedSessionActor(request: Request, context: FeedHostContext): string | undefined {
  const token = actorSessionToken(request);
  if (!token) return undefined;
  const session = context.actorSessions.get(token);
  if (!session || session.policyHash !== context.policyHash) return undefined;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    context.actorSessions.delete(token);
    return undefined;
  }
  const actor = context.actors.get(session.actorKey);
  if (!actor) return undefined;
  const claimedActor = request.headers.get("x-feed-actor-id");
  if (claimedActor && !actorIdsMatch(claimedActor, actor.actorId)) return undefined;
  return actor.actorId;
}

function issueActorSession(context: FeedHostContext, actorKey: string, expiresAt: string): string {
  const now = Date.now();
  const existingActorTokens: string[] = [];
  for (const [existingToken, session] of context.actorSessions) {
    if (Date.parse(session.expiresAt) <= now) {
      context.actorSessions.delete(existingToken);
    } else if (session.actorKey === actorKey) {
      existingActorTokens.push(existingToken);
    }
  }
  for (const existingToken of existingActorTokens.slice(0, Math.max(0, existingActorTokens.length - MAX_ACTOR_SESSIONS + 1))) {
    context.actorSessions.delete(existingToken);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Buffer.from(bytes).toString("base64url");
  context.actorSessions.set(token, { actorKey, expiresAt, policyHash: context.policyHash });
  return token;
}

function bindAuthenticatedActor(request: Request, actorId: string): Request {
  const headers = new Headers(request.headers);
  headers.set("x-feed-actor-id", actorId);
  return new Request(request, { headers });
}

function actorSessionToken(request: Request): string | undefined {
  const cookie = request.headers.get("cookie");
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "__Host-feed_session" || name === "feed_session") return value.join("=") || undefined;
  }
  return undefined;
}

function actorSessionCookie(token: string, request: Request, expiresAt: string): string {
  const secure = requestIsSecure(request);
  const name = secure ? "__Host-feed_session" : "feed_session";
  const sameSite = secure && isCrossSiteOrigin(request) ? "None" : secure ? "Strict" : "Lax";
  return `${name}=${token}; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=${sameSite}; Expires=${new Date(expiresAt).toUTCString()}`;
}

function clearedActorSessionCookie(request: Request): string {
  const secure = requestIsSecure(request);
  const name = secure ? "__Host-feed_session" : "feed_session";
  return `${name}=; Path=/; HttpOnly; ${secure ? "Secure; " : ""}SameSite=${secure ? "None" : "Lax"}; Max-Age=0`;
}

function requestIsSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
}

function isCrossSiteOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return registrableSite(new URL(origin).hostname) !== registrableSite(new URL(request.url).hostname);
  } catch {
    return true;
  }
}

function registrableSite(hostname: string): string {
  const labels = hostname.toLowerCase().split(".");
  return labels.length > 1 ? labels.slice(-2).join(".") : hostname.toLowerCase();
}

function earliestExpiry(left: string | undefined, right: string): string {
  if (!left) return right;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

async function requireCompleteActor(request: Request, context: FeedHostContext): Promise<ActorState> {
  const actorId = requireRequestActorId(request);
  return requireDelegationAndReady(context, actorId);
}

async function requireDevPublisherActor(request: Request, context: FeedHostContext): Promise<ActorState> {
  const actorId = request.headers.get("x-feed-actor-id");
  if (actorId) return requireDelegationAndReady(context, actorId);
  if (context.actors.size === 1) {
    const actor = [...context.actors.values()][0]!;
    await ensureActorReady(context.storage, actor, context.seedOnStart);
    return actor;
  }
  throw new FeedHostError("x-feed-actor-id is required unless exactly one actor is active", 401, "unauthorized");
}

async function requireDelegationAndReady(context: FeedHostContext, actorId: string): Promise<ActorState> {
  const actor = await requireDelegation(context, actorId);
  await ensureActorReady(context.storage, actor, context.seedOnStart);
  return actor;
}

function requireRequestActorId(request: Request): string {
  const actorId = request.headers.get("x-feed-actor-id");
  if (!actorId) throw new FeedHostError("missing delegated actor", 401, "unauthorized");
  return actorId;
}

async function requireDelegation(context: FeedHostContext, actorId: string): Promise<ActorState> {
  if (!actorId) throw new FeedHostError("missing delegated actor", 401, "unauthorized");
  const actorKey = normalizeActorId(actorId);
  let delegation = context.actors.get(actorKey);
  if (delegation && isDelegationExpired(delegation)) {
    throw new FeedDelegationError("accepted delegation has expired", "expired");
  }
  if (!hasCompleteFeedHostDelegation(delegation) && context.delegationStore) {
    delegation = (await restoreActorFromStore(context, actorKey)) ?? delegation;
  }
  if (!hasCompleteFeedHostDelegation(delegation)) {
    throw new FeedDelegationError("Feed Host has no complete accepted delegation for actor", "insufficient_policy");
  }
  return delegation;
}

async function persistAcceptedDelegation(
  store: FeedHostDelegationStore,
  policy: FeedHostDelegationPolicy,
  policyHash: string,
  actorId: string,
  accepted: { serializedDelegation: string; resources: string[]; acceptedAt: string; expiresAt: string },
): Promise<void> {
  const existing = await store.load(actorId);
  const prior =
    existing && existing.delegateDID === policy.delegateDID && (existing.policyHash ?? policyHash) === policyHash
      ? liveDelegationResources(existing)
      : [];
  const kept = prior.filter((resource) => !accepted.resources.includes(resource.path));
  const added = accepted.resources.map((path) => ({
    path,
    serializedDelegation: accepted.serializedDelegation,
    acceptedAt: accepted.acceptedAt,
    expiresAt: accepted.expiresAt,
  }));
  await store.save({ actorId, delegateDID: policy.delegateDID, resources: [...kept, ...added], policyHash });
}

async function removeDelegation(context: FeedHostContext, actorId: string): Promise<void> {
  const actorKey = normalizeActorId(actorId);
  context.actors.delete(actorKey);
  for (const [token, session] of context.actorSessions) {
    if (session.actorKey === actorKey) context.actorSessions.delete(token);
  }
  if (context.delegationStore) {
    await context.delegationStore.remove(actorKey);
  }
}

async function readDelegationStatus(
  context: FeedHostContext,
  actorId: string,
): Promise<{
  actorId: string;
  delegateDID: string;
  policyHash: string;
  currentPolicyHash: string;
  state: "missing" | "active" | "partial" | "expired" | "stale";
  complete: boolean;
  resources: Array<{ path: string; acceptedAt: string; expiresAt: string }>;
  setup?: ActorPreparationStatus;
}> {
  const actorKey = normalizeActorId(actorId);
  const liveActor = context.actors.get(actorKey);
  if (liveActor && hasCompleteFeedHostDelegation(liveActor) && !isDelegationExpired(liveActor)) {
    return {
      actorId: liveActor.actorId,
      delegateDID: context.policy.delegateDID,
      policyHash: context.policyHash,
      currentPolicyHash: context.policyHash,
      state: "active",
      complete: true,
      setup: actorPreparationSnapshot(liveActor),
      resources: liveActor.resources.map((path) => ({
        path,
        acceptedAt: liveActor.acceptedAt,
        expiresAt: liveActor.expiresAt,
      })),
    };
  }

  if (liveActor && isDelegationExpired(liveActor)) {
    return {
      actorId: liveActor.actorId,
      delegateDID: context.policy.delegateDID,
      policyHash: context.policyHash,
      currentPolicyHash: context.policyHash,
      state: "expired",
      complete: false,
      resources: liveActor.resources.map((path) => ({
        path,
        acceptedAt: liveActor.acceptedAt,
        expiresAt: liveActor.expiresAt,
      })),
    };
  }

  if (!context.delegationStore) {
    return {
      actorId,
      delegateDID: context.policy.delegateDID,
      policyHash: context.policyHash,
      currentPolicyHash: context.policyHash,
      state: "missing",
      complete: false,
      resources: [],
    };
  }

  const stored = await context.delegationStore.load(actorKey);
  if (!stored) {
    return {
      actorId,
      delegateDID: context.policy.delegateDID,
      policyHash: context.policyHash,
      currentPolicyHash: context.policyHash,
      state: "missing",
      complete: false,
      resources: [],
    };
  }

  const liveResources = liveDelegationResources(stored).map((resource) => ({
    path: resource.path,
    acceptedAt: resource.acceptedAt,
    expiresAt: resource.expiresAt,
  }));
  const complete = liveResources.length === stored.resources.length && liveResources.length > 0 && stored.policyHash === context.policyHash;
  const state =
    stored.policyHash && stored.policyHash !== context.policyHash
      ? "stale"
      : liveResources.length === 0
        ? "expired"
        : complete
          ? "active"
          : "partial";
  return {
    actorId: stored.actorId,
    delegateDID: stored.delegateDID,
    policyHash: stored.policyHash ?? context.policyHash,
    currentPolicyHash: context.policyHash,
    state,
    complete,
    resources: liveResources,
  };
}

async function restoreActorFromStore(
  context: FeedHostContext,
  actorKey: string,
): Promise<ActorState | null> {
  const store = context.delegationStore;
  if (!store) return null;
  const stored = await store.load(actorKey);
  if (!stored) return null;
  if (stored.policyHash && stored.policyHash !== context.policyHash) {
    throw new FeedDelegationError("stored delegation policy hash is stale", "delegation_stale");
  }
  if (stored.delegateDID !== context.policy.delegateDID) {
    await store.remove(actorKey);
    return null;
  }
  const live = liveDelegationResources(stored);
  if (live.length === 0) {
    await store.remove(actorKey);
    return null;
  }
  if (live.length !== stored.resources.length) {
    await store.save({ ...stored, resources: live, policyHash: stored.policyHash ?? context.policyHash });
  }
  try {
    const accessByResource = new Map<string, DelegatedAccess>();
    const resources: string[] = [];
    let actorId = actorKey;
    let acceptedAt = new Date().toISOString();
    // A multi-resource delegation is persisted as one record per covered
    // path, all sharing the same serialized blob — activate each blob once.
    const uniqueDelegations = [...new Map(live.map((resource) => [resource.serializedDelegation, resource])).values()];
    for (const resource of uniqueDelegations) {
      const accepted = await context.activateDelegation({
        serializedDelegation: resource.serializedDelegation,
        expectedDelegateDID: context.policy.delegateDID,
      });
      if (!actorIdsMatch(accepted.actorId, actorKey)) {
        throw new FeedDelegationError("stored delegation owner does not match actor", "actor_mismatch");
      }
      for (const path of accepted.resources) accessByResource.set(path, accepted.access);
      resources.push(...accepted.resources);
      actorId = accepted.actorId;
      acceptedAt = accepted.acceptedAt;
    }
    const state: ActorState = {
      actorId,
      acceptedAt,
      expiresAt: live[0]?.expiresAt ?? new Date().toISOString(),
      resources: [...new Set(resources)],
      accessByResource,
    };
    context.actors.set(actorKey, state);
    return state;
  } catch (error) {
    if (error instanceof FeedDelegationError) {
      await store.remove(actorKey);
      return null;
    }
    throw error;
  }
}

function actorStorage(actor: ActorState): FeedHostActorStorage {
  if (actor.storageAccess) return actor.storageAccess;
  const artifacts = actor.accessByResource.get(FEED_HOST_ARTIFACTS_DB_PATH);
  const feed = actor.accessByResource.get(FEED_HOST_FEED_DB_PATH);
  const settings = actor.accessByResource.get(FEED_HOST_FEED_SETTINGS_PREFIX);
  const documents = actor.accessByResource.get(FEED_HOST_ARTIFACT_DOC_PREFIX);
  if (!artifacts || !feed || !settings || !documents) {
    throw new FeedDelegationError("Feed Host delegation is missing activated TinyCloud access", "insufficient_policy");
  }
  actor.storageAccess = {
    actorId: actor.actorId,
    artifacts,
    feed,
    settings,
    documents,
    legacyArtifacts: actor.accessByResource.get(LEGACY_FEED_DB_PATH),
    legacyInteractions: actor.accessByResource.get(LEGACY_INTERACTIONS_DB_PATH),
  };
  return actor.storageAccess;
}

async function ensureActorReady(storage: FeedHostStorage, actor: ActorState, seedOnStart: boolean): Promise<void> {
  if (!actor.ready) {
    const startedAt = new Date().toISOString();
    actor.preparation = {
      state: "preparing",
      phase: "bootstrap",
      attempt: (actor.preparation?.attempt ?? 0) + 1,
      startedAt,
      updatedAt: startedAt,
    };
    const ready = (async () => {
      try {
        const access = actorStorage(actor);
        await retryTinyCloudTransaction("bootstrap", actor.actorId, () => storage.bootstrapSchema(access));
        updateActorPreparation(actor, "artifact_check");
        if (seedOnStart && !(await retryTinyCloudTransaction("artifact_check", actor.actorId, () => storage.hasArtifacts(access)))) {
          updateActorPreparation(actor, "seed");
          await retryTinyCloudTransaction("seed", actor.actorId, () => seedDefaultFeed(storage, access));
        }
        updateActorPreparation(actor, "reconcile");
        await retryTinyCloudTransaction("reconcile", actor.actorId, () => storage.reconcileFeedProjection(access));
        const completedAt = new Date().toISOString();
        actor.preparation = {
          ...actorPreparationSnapshot(actor),
          state: "ready",
          phase: "ready",
          updatedAt: completedAt,
          completedAt,
          error: undefined,
        };
      } catch (error) {
        const completedAt = new Date().toISOString();
        actor.preparation = {
          ...actorPreparationSnapshot(actor),
          state: "failed",
          phase: "failed",
          updatedAt: completedAt,
          completedAt,
          error: {
            code: "preparation_failed",
            message: publicPreparationError(error),
          },
        };
        throw error;
      }
    })();
    actor.ready = ready;
    ready.catch(() => {
      if (actor.ready === ready) actor.ready = undefined;
    });
  }
  await actor.ready;
}

function updateActorPreparation(actor: ActorState, phase: ActorPreparationPhase): void {
  actor.preparation = {
    ...actorPreparationSnapshot(actor),
    state: "preparing",
    phase,
    updatedAt: new Date().toISOString(),
    completedAt: undefined,
    error: undefined,
  };
}

function actorPreparationSnapshot(actor: ActorState): ActorPreparationStatus {
  return actor.preparation ?? {
    state: "not_started",
    phase: "idle",
    attempt: 0,
    startedAt: actor.acceptedAt,
    updatedAt: actor.acceptedAt,
  };
}

function publicPreparationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 500) || "Feed preparation failed";
}

async function retryTinyCloudTransaction<T>(operation: string, actorId: string | undefined, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const delay = TINYCLOUD_TRANSACTION_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isTinyCloudSerializationConflict(error)) throw error;
      logEvent("warn", "tinycloud_transaction_retry", {
        ...(actorId ? { actor: actorId } : {}),
        operation,
        attempt: attempt + 1,
        delayMs: delay,
      });
      await Bun.sleep(delay);
    }
  }
}

async function serializeActorRequest<T>(
  queues: Map<string, Promise<void>>,
  actorId: string,
  run: () => Promise<T>,
): Promise<T> {
  const actorKey = normalizeActorId(actorId);
  const previous = queues.get(actorKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  const tail = current.then(() => undefined, () => undefined);
  queues.set(actorKey, tail);
  try {
    return await current;
  } finally {
    if (queues.get(actorKey) === tail) queues.delete(actorKey);
  }
}

export function isTinyCloudSerializationConflict(error: unknown): boolean {
  const detail = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
  return detail.includes("could not serialize access") || detail.includes("read/write dependencies among transactions");
}

async function readJsonObject(request: Request, code: string, message: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new FeedHostError(message, 400, code);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new FeedHostError(message, 400, code);
  }
  return body as Record<string, unknown>;
}

function normalizeFeedbackEvent(body: Record<string, unknown>, actorId: string): FeedTargetedInteractionEvent {
  const signal = readSignal(body.signal);
  const event: FeedTargetedInteractionEvent = {
    eventId: readString(body, "eventId", "invalid_feedback", "eventId is required"),
    target: normalizeInteractionTarget(body.target, body.artifactId),
    actorId,
    readerNonce: readString(body, "readerNonce", "invalid_feedback", "readerNonce is required"),
    signal,
    payload: sanitizeFeedbackPayload(signal, body.payload),
    createdAt: readString(body, "createdAt", "invalid_feedback", "createdAt is required"),
  };
  const validated = validateFeedTargetedInteractionEvent(event);
  if (!validated.ok) throw new FeedHostError(validated.errors.join("; "), 400, "invalid_feedback");
  return validated.value;
}

function normalizeInteractionTarget(value: unknown, legacyArtifactId: unknown): FeedInteractionTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {
      kind: "artifact",
      artifactId: readString({ artifactId: legacyArtifactId }, "artifactId", "invalid_feedback", "target or artifactId is required"),
    };
  }
  const target = value as Record<string, unknown>;
  if (target.kind === "artifact") {
    return { kind: "artifact", artifactId: readString(target, "artifactId", "invalid_feedback", "target.artifactId is required") };
  }
  if (target.kind === "post") {
    return {
      kind: "post",
      artifactId: readString(target, "artifactId", "invalid_feedback", "target.artifactId is required"),
      postId: readString(target, "postId", "invalid_feedback", "target.postId is required"),
    };
  }
  if (target.kind === "feed_item") {
    return { kind: "feed_item", feedItemId: readString(target, "feedItemId", "invalid_feedback", "target.feedItemId is required") };
  }
  throw new FeedHostError("target.kind is invalid", 400, "invalid_feedback");
}

function normalizeSkillCredentialsPatch(body: Record<string, unknown>): FeedHostSkillCredentialsPatch {
  const expectedVersion = optionalNumber(body.expectedVersion);
  const credentialMode = optionalString(body.credentialMode);
  if (expectedVersion === undefined || credentialMode === undefined) {
    throw new FeedHostError("expectedVersion and credentialMode are required", 400, "invalid_skill_credentials");
  }
  const patch: FeedHostSkillCredentialsPatch = {
    expectedVersion,
    credentialMode: credentialMode as FeedHostSkillCredentialsPatch["credentialMode"],
  };
  const providerId = optionalString(body.providerId);
  if (providerId) patch.providerId = providerId;
  const secretRef = optionalString(body.secretRef);
  if (secretRef) patch.secretRef = secretRef;
  if (body.budget !== undefined) {
    const budget = optionalObject(body.budget);
    if (!budget) throw new FeedHostError("budget must be an object", 400, "invalid_skill_credentials");
    patch.budget = {
      budgetId: optionalString(budget.budgetId),
      limit: optionalNumber(budget.limit),
      spent: optionalNumber(budget.spent),
      currency: optionalString(budget.currency),
      disabled: typeof budget.disabled === "boolean" ? budget.disabled : undefined,
    };
  }
  return patch;
}

function normalizeDevPublishArtifact(body: Record<string, unknown>): FeedArtifact {
  const candidate = body.artifact ?? body;
  const result = validateFeedArtifact(candidate);
  if (!result.ok) {
    throw new FeedHostError(`invalid Feed v1 artifact: ${result.errors.join("; ")}`, 400, "invalid_artifact");
  }
  return result.value;
}

function normalizeControlIntentEvent(body: Record<string, unknown>, actorId: string): FeedControlIntentInput {
  return {
    eventId: readString(body, "eventId", "invalid_intent", "eventId is required"),
    actorId,
    readerNonce: readString(body, "readerNonce", "invalid_intent", "readerNonce is required"),
    intentKind: readControlIntentKind(body.intentKind),
    status: typeof body.status === "string" && body.status.trim() !== "" ? body.status : "accepted",
    targetRef: readString(body, "targetRef", "invalid_intent", "targetRef is required"),
    payload: body.payload,
    payloadHash: optionalString(body.payloadHash) ?? undefined,
    createdAt: readString(body, "createdAt", "invalid_intent", "createdAt is required"),
  };
}

function normalizeControlIntentRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    eventId: stringField(row, "eventId") ?? stringField(row, "event_id"),
    readerNonce: stringField(row, "readerNonce") ?? stringField(row, "reader_nonce"),
    actorId: stringField(row, "actorId") ?? stringField(row, "actor_id"),
    intentKind: stringField(row, "intentKind") ?? stringField(row, "intent_kind"),
    status: stringField(row, "status"),
    targetRef: stringField(row, "targetRef") ?? stringField(row, "target_ref"),
    payloadHash: stringField(row, "payloadHash") ?? stringField(row, "payload_hash") ?? null,
    payload: parseMaybeJson(stringField(row, "payloadJson") ?? stringField(row, "payload_json")),
    createdAt: stringField(row, "createdAt") ?? stringField(row, "created_at"),
  };
}

function normalizeGenerationRequestRecord(row: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: stringField(row, "requestId") ?? stringField(row, "request_id"),
    readerNonce: stringField(row, "readerNonce") ?? stringField(row, "reader_nonce"),
    actorId: stringField(row, "actorId") ?? stringField(row, "actor_id"),
    status: stringField(row, "status"),
    scope: parseMaybeJson(stringField(row, "scopeJson") ?? stringField(row, "scope_json")) ?? {},
    packageId: stringField(row, "packageId") ?? stringField(row, "package_id") ?? null,
    dedupeKey: stringField(row, "dedupeKey") ?? stringField(row, "dedupe_key") ?? null,
    prompt: stringField(row, "prompt") ?? null,
    runId: stringField(row, "runId") ?? stringField(row, "run_id") ?? null,
    workflowId: stringField(row, "workflowId") ?? stringField(row, "workflow_id") ?? null,
    maxAttempts: numberField(row, "maxAttempts") ?? numberField(row, "max_attempts") ?? 3,
    claimOwner: stringField(row, "claimOwner") ?? stringField(row, "claim_owner") ?? null,
    leaseExpiresAt: stringField(row, "leaseExpiresAt") ?? stringField(row, "lease_expires_at") ?? null,
    fencingToken: numberField(row, "fencingToken") ?? numberField(row, "fencing_token") ?? 0,
    attemptCount: numberField(row, "attemptCount") ?? numberField(row, "attempt_count") ?? 0,
    nextRetryAt: stringField(row, "nextRetryAt") ?? stringField(row, "next_retry_at") ?? null,
    cancellationRequested:
      booleanField(row, "cancellationRequested") ?? numberField(row, "cancellation_requested") === 1,
    phase: stringField(row, "phase") ?? "queued",
    phaseStartedAt: stringField(row, "phaseStartedAt") ?? stringField(row, "phase_started_at") ?? null,
    startedAt: stringField(row, "startedAt") ?? stringField(row, "started_at") ?? null,
    completedAt: stringField(row, "completedAt") ?? stringField(row, "completed_at") ?? null,
    lastAttemptAt: stringField(row, "lastAttemptAt") ?? stringField(row, "last_attempt_at") ?? null,
    sourceCursorBefore: row.sourceCursorBefore ?? parseMaybeJson(stringField(row, "source_cursor_before")),
    sourceCursorAfter: row.sourceCursorAfter ?? parseMaybeJson(stringField(row, "source_cursor_after")),
    sourceRefs: row.sourceRefs ?? parseMaybeJson(stringField(row, "source_refs_json")) ?? [],
    publicationKey: stringField(row, "publicationKey") ?? stringField(row, "publication_key") ?? null,
    artifactIds: row.artifactIds ?? parseMaybeJson(stringField(row, "artifact_ids_json")) ?? [],
    error: row.error ?? parseMaybeJson(stringField(row, "error_json")) ?? null,
    timingEvents: row.timingEvents ?? parseMaybeJson(stringField(row, "timing_events_json")) ?? [],
    expiresAt: stringField(row, "expiresAt") ?? stringField(row, "expires_at"),
    createdAt: stringField(row, "createdAt") ?? stringField(row, "created_at"),
    updatedAt: stringField(row, "updatedAt") ?? stringField(row, "updated_at"),
  };
}

function parseMaybeJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readString(body: Record<string, unknown>, key: string, code: string, message: string): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new FeedHostError(message, 400, code);
  }
  return value;
}

function readSignal(value: unknown): FeedbackEvent["signal"] {
  if (
    value === "save" ||
    value === "unsave" ||
    value === "hide" ||
    value === "unhide" ||
    value === "helpful" ||
    value === "unhelpful" ||
    value === "show_fewer" ||
    value === "text_note"
  ) {
    return value;
  }
  throw new FeedHostError("signal is required", 400, "invalid_feedback");
}

function sanitizeFeedbackPayload(signal: FeedbackEvent["signal"], payload: unknown): unknown {
  if (signal !== "text_note") return undefined;
  const note = extractFeedbackNote(payload);
  if (!note) {
    throw new FeedHostError("note is required for text_note feedback", 400, "invalid_feedback");
  }
  return { note };
}

function extractFeedbackNote(payload: unknown): string | undefined {
  let candidate: unknown;
  if (typeof payload === "string") {
    candidate = payload;
  } else if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    candidate = typeof record.note === "string" ? record.note : typeof record.text === "string" ? record.text : undefined;
  }
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, FEEDBACK_NOTE_MAX_CHARS);
}

function readGenerationRequestStatus(value: unknown): FeedGenerationRequestRecord["status"] {
  if (
    value === "accepted" ||
    value === "pending" ||
    value === "blocked" ||
    value === "rejected" ||
    value === "consumed" ||
    value === "expired" ||
    value === "retry_wait" ||
    value === "cancelled" ||
    value === "dead_letter"
  ) {
    return value;
  }
  throw new FeedHostError(
    "status must be one of accepted|pending|retry_wait|blocked|rejected|consumed|expired|cancelled|dead_letter",
    400,
    "invalid_generation_status",
  );
}

function readControlIntentKind(value: unknown): FeedControlIntentKind {
  if (
    value === "enable_package" ||
    value === "pause_package" ||
    value === "disable_package" ||
    value === "tune_package" ||
    value === "reset_package" ||
    value === "ask_feed" ||
    value === "set_artifact_visibility" ||
    value === "set_saved" ||
    value === "adjust_preference" ||
    value === "set_cadence" ||
    value === "generate_new_request" ||
    value === "safe_package_setting_update" ||
    value === "reset_preferences" ||
    value === "candidate_package_proposal"
  ) {
    return value;
  }
  throw new FeedHostError("intentKind is required", 400, "invalid_intent");
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new FeedHostError(`value must be an integer from ${minimum} to ${maximum}`, 400, "invalid_worker_request");
  }
  return value;
}

function readWorkerPhase(value: unknown): "running" | "validating" {
  if (value === "running" || value === "validating") {
    return value;
  }
  throw new FeedHostError("phase is not allowed", 400, "invalid_worker_request");
}

function readWorkerMetadata(value: unknown): {
  sourceCursorAfter?: unknown;
  sourceRefs?: unknown[];
  timingEvents?: Array<{ name: string; at: string; durationMs?: number }>;
} {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeedHostError("metadata must be an object", 400, "invalid_worker_request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["sourceCursorAfter", "sourceRefs", "timingEvents"].includes(key))) {
    throw new FeedHostError("metadata contains unsupported fields", 400, "invalid_worker_request");
  }
  return {
    ...(Object.hasOwn(record, "sourceCursorAfter") ? { sourceCursorAfter: record.sourceCursorAfter } : {}),
    ...(record.sourceRefs === undefined ? {} : { sourceRefs: readObjectArray(record.sourceRefs, "sourceRefs", 500) }),
    ...(record.timingEvents === undefined ? {} : { timingEvents: readWorkerTimingEvents(record.timingEvents) }),
  };
}

function readWorkerTimingEvents(value: unknown): Array<{ name: string; at: string; durationMs?: number }> | undefined {
  if (value === undefined) return undefined;
  const events = readObjectArray(value, "timingEvents", 128);
  return events.map((event) => {
    const name = readString(event, "name", "invalid_worker_request", "timing event name is required");
    const at = readString(event, "at", "invalid_worker_request", "timing event timestamp is required");
    if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(name) || !Number.isFinite(Date.parse(at))) {
      throw new FeedHostError("timing event is invalid", 400, "invalid_worker_request");
    }
    const durationMs = event.durationMs;
    if (durationMs !== undefined && (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0)) {
      throw new FeedHostError("timing event durationMs is invalid", 400, "invalid_worker_request");
    }
    return { name, at, ...(durationMs === undefined ? {} : { durationMs }) };
  });
}

function readWorkerArtifacts(value: unknown): FeedArtifact[] {
  return readObjectArray(value, "artifacts", 32) as FeedArtifact[];
}

function readObjectArray(value: unknown, field: string, maximum: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new FeedHostError(`${field} must be an array of at most ${maximum} objects`, 400, "invalid_worker_request");
  }
  return value as Record<string, unknown>[];
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new FeedHostError(`${field} must be an array of strings`, 400, "invalid_worker_request");
  }
  return value as string[];
}

function readWorkerOutcome(value: unknown): "published" | "zero_artifacts" {
  if (value === "published" || value === "zero_artifacts") return value;
  throw new FeedHostError("outcome must be published or zero_artifacts", 400, "invalid_worker_request");
}

function readWorkerErrorCode(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,99}$/i.test(value)) {
    throw new FeedHostError("errorCode is required", 400, "invalid_worker_request");
  }
  return value;
}

function numberField(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(body: Record<string, unknown>, key: string): boolean | undefined {
  return typeof body[key] === "boolean" ? body[key] : undefined;
}

function objectField(body: Record<string, unknown>, key: string): Record<string, number> | undefined {
  const value = body[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, number> : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalObject(value: unknown): JsonBody | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonBody;
}

function parseLimit(value: string | null): number {
  if (value === null || value === "") return 40;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new FeedHostError("limit must be a number", 400, "bad_request");
  return Math.max(1, Math.min(Math.trunc(parsed), 100));
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function jsonError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function mapError(error: unknown, pathname: string): Response {
  if (error instanceof FeedHostError) {
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      error.status,
    );
  }

  if (error instanceof FeedDelegationError) {
    if (error.code === "delegation_stale") {
      return json({ error: { code: "delegation_stale", message: error.message } }, 409);
    }
    if (error.code === "expired") {
      return json({ error: { code: "delegation_stale", message: error.message } }, 409);
    }
    if (error.code === "malformed") {
      return json({ error: { code: "invalid_delegation", message: error.message } }, 400);
    }
    if (error.code === "actor_mismatch") {
      return json({ error: { code: "actor_mismatch", message: error.message } }, 403);
    }
    if (error.code === "wrong_delegatee" || error.code === "insufficient_policy") {
      return json({ error: { code: "denied", message: error.message } }, 403);
    }
    return json({ error: { code: error.code, message: error.message } }, 403);
  }

  if (pathname === "/api/server-info" || pathname === "/api/openapi.json" || pathname === "/delegation-policy" || pathname === "/health") {
    return json({ error: { code: "unavailable", message: "service unavailable" } }, 503);
  }
  return json({ error: { code: "internal_error", message: "internal service error" } }, 500);
}

function errorLogFields(error: unknown): { errorClass: string; errorMessage: string } {
  const errorClass = error instanceof Error ? error.name : typeof error;
  const errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  return { errorClass, errorMessage };
}

function etagMatches(headerValue: string | null, etag: string): boolean {
  if (!headerValue) return false;
  return headerValue
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === etag || value === `W/${etag}`);
}

function quotedEtag(value: string): string {
  return `"${value}"`;
}

function isDelegationExpired(actor: Pick<ActorState, "expiresAt">): boolean {
  const expiry = Date.parse(actor.expiresAt);
  return !Number.isFinite(expiry) || expiry <= Date.now();
}

function resolveRequestActorId(request: Request, bodyActorId: unknown): string {
  const headerActorId = requireRequestActorId(request);
  if (typeof bodyActorId === "string" && bodyActorId.trim() !== "" && !actorIdsMatch(headerActorId, bodyActorId)) {
    throw new FeedDelegationError("payload actorId does not match the request actor", "actor_mismatch");
  }
  return headerActorId;
}

function optionsFromEnv(): FeedHostServerOptions {
  const stateDir = process.env.FEED_HOST_STATE_DIR;
  const allowedOrigins = process.env.FEED_HOST_ALLOWED_ORIGINS
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    port: Number(process.env.FEED_HOST_PORT ?? "8787"),
    hostname: process.env.FEED_HOST_HOSTNAME ?? "127.0.0.1",
    token: process.env.FEED_HOST_TOKEN || undefined,
    workerToken: process.env.FEED_HOST_WORKER_TOKEN || undefined,
    tinycloudHost: process.env.TINYCLOUD_HOST || process.env.VITE_TINYCLOUD_HOST || undefined,
    hostPrivateKey: process.env.FEED_HOST_PRIVATE_KEY || (stateDir ? ensureFeedHostPrivateKey(stateDir) : undefined),
    seedOnStart: process.env.FEED_HOST_SEED !== "0",
    enableDevPublisher: process.env.FEED_HOST_DEV_PUBLISH === "1",
    requireActorSession: true,
    allowedOrigins: allowedOrigins?.length ? allowedOrigins : undefined,
  };
}

if (import.meta.main) {
  const runtime = startFeedHost(optionsFromEnv());
  console.log(`Feed Host listening on ${runtime.url}`);
}
