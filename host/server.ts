import type { DelegatedAccess, TinyCloudNode } from "@tinycloud/node-sdk";
import type {
  ControlIntentEvent,
  FeedArtifact,
  FeedbackEvent,
} from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import type { FeedControlIntentInput, FeedControlIntentKind, FeedGenerationRequestRecord } from "./logic.ts";
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
  expiresAt: string;
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

const SSE_HEADERS = {
  ...CORS_HEADERS,
  "content-type": "text/event-stream",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

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
    };
    return context;
  };

  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    // TinyCloud round-trips can exceed Bun's default idle timeout.
    idleTimeout: 120,
    async fetch(request) {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      const url = new URL(request.url);
      const startedAt = performance.now();
      const logRequest = (response: Response, errorCode?: string) => {
        if (request.method === "GET" && PUBLIC_PATHS.has(url.pathname)) return response;
        logEvent(levelForStatus(response.status), "http_request", {
          method: request.method,
          path: url.pathname,
          status: response.status,
          ms: Math.round(performance.now() - startedAt),
          actor: request.headers.get("x-feed-actor-id") ?? undefined,
          ...(errorCode ? { code: errorCode } : {}),
        });
        return response;
      };

      const publicRoute = PUBLIC_PATHS.has(url.pathname);
      if (!publicRoute && !authorized(request, options.token)) {
        return logRequest(jsonError(401, "unauthorized", "missing or invalid bearer token"), "unauthorized");
      }

      try {
        return logRequest(await route(request, await getContext()));
      } catch (error) {
        const errorCode =
          error instanceof FeedHostError ? error.code : error instanceof FeedDelegationError ? error.code : "internal_error";
        return logRequest(mapError(error, url.pathname), errorCode);
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
  const { storage, policy, policyHash, serverInfo, actors, activateDelegation, seedOnStart, delegationStore } = context;
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

  if (request.method === "DELETE" && url.pathname === "/api/delegations") {
    const actorId = requireRequestActorId(request);
    await removeDelegation(context, actorId);
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method === "POST" && url.pathname === "/api/delegations") {
    const body = await readJsonObject(request, "invalid_delegation", "delegation body must be JSON");
    const serializedDelegation = readString(body, "serializedDelegation", "invalid_delegation", "serializedDelegation is required");
    const payloadActorId = optionalString(body.actorId);
    const activated = await activateDelegation({
      serializedDelegation,
      expectedDelegateDID: policy.delegateDID,
    }).catch((error) => {
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
    if (payloadActorId && !actorIdsMatch(payloadActorId, activated.actorId)) {
      throw new FeedHostError("actorId does not match the delegation owner identity", 403, "actor_mismatch");
    }

    const actorKey = normalizeActorId(activated.actorId);
    const existing = actors.get(actorKey);
    const resources = [...new Set([...(existing?.resources ?? []), ...activated.resources])];
    const accessByResource = new Map(existing?.accessByResource);
    for (const resource of activated.resources) accessByResource.set(resource, activated.access);
    const state: ActorState = {
      actorId: activated.actorId,
      acceptedAt: activated.acceptedAt,
      expiresAt: activated.expiresAt,
      resources,
      accessByResource,
      storageAccess: existing?.storageAccess,
      ready: existing?.ready,
    };
    actors.set(actorKey, state);
    if (delegationStore) {
      await persistAcceptedDelegation(delegationStore, policy, policyHash, actorKey, {
        serializedDelegation,
        resources: activated.resources,
        acceptedAt: activated.acceptedAt,
        expiresAt: activated.expiresAt,
      });
    }
    if (hasCompleteFeedHostDelegation(state)) await ensureActorReady(storage, state, seedOnStart);
    return json({
      accepted: true,
      actorId: activated.actorId,
      resources,
      policyHash,
      status: hasCompleteFeedHostDelegation(state) ? "active" : "activation_pending",
    });
  }

  // Browser-side failures (sign-in, delegation minting, feed setup) happen
  // before any delegation exists, so this ingestion route needs no actor —
  // it only feeds the structured log stream. Input is tightly bounded.
  if (request.method === "POST" && url.pathname === "/api/client-events") {
    const body = await readJsonObject(request, "invalid_client_event", "client event body must be JSON");
    const entries = Array.isArray(body.events) ? body.events.slice(0, 20) : [body];
    const actor = optionalString(request.headers.get("x-feed-actor-id"));
    let accepted = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const eventName = optionalString(record.event);
      if (!eventName) continue;
      const level = record.level === "error" || record.level === "warn" ? record.level : "info";
      logEvent(level, `client_${eventName.slice(0, 64)}`, {
        source: "web",
        ...(actor ? { actor } : {}),
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

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return true;
  return request.headers.get("authorization") === `Bearer ${token}`;
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
    actor.ready = (async () => {
      const access = actorStorage(actor);
      await storage.bootstrapSchema(access);
      if (seedOnStart && !(await storage.hasArtifacts(access))) {
        await seedDefaultFeed(storage, access);
      }
      await storage.reconcileFeedProjection(access);
    })();
  }
  await actor.ready;
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

function normalizeFeedbackEvent(body: Record<string, unknown>, actorId: string): FeedbackEvent {
  const signal = readSignal(body.signal);
  return {
    eventId: readString(body, "eventId", "invalid_feedback", "eventId is required"),
    artifactId: readString(body, "artifactId", "invalid_feedback", "artifactId is required"),
    actorId,
    readerNonce: readString(body, "readerNonce", "invalid_feedback", "readerNonce is required"),
    signal,
    payload: sanitizeFeedbackPayload(signal, body.payload),
    createdAt: readString(body, "createdAt", "invalid_feedback", "createdAt is required"),
  };
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
    value === "expired"
  ) {
    return value;
  }
  throw new FeedHostError(
    "status must be one of accepted|pending|blocked|rejected|consumed|expired",
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

  const message = error instanceof Error ? error.message : String(error);
  if (pathname === "/api/server-info" || pathname === "/api/openapi.json" || pathname === "/delegation-policy" || pathname === "/health") {
    return json({ error: { code: "unavailable", message } }, 503);
  }
  return json({ error: { code: "internal_error", message } }, 500);
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
  return {
    port: Number(process.env.FEED_HOST_PORT ?? "8787"),
    hostname: process.env.FEED_HOST_HOSTNAME ?? "127.0.0.1",
    token: process.env.FEED_HOST_TOKEN || undefined,
    tinycloudHost: process.env.TINYCLOUD_HOST || process.env.VITE_TINYCLOUD_HOST || undefined,
    hostPrivateKey: process.env.FEED_HOST_PRIVATE_KEY || undefined,
    seedOnStart: process.env.FEED_HOST_SEED !== "0",
    enableDevPublisher: process.env.FEED_HOST_DEV_PUBLISH === "1",
  };
}

if (import.meta.main) {
  const runtime = startFeedHost(optionsFromEnv());
  console.log(`Feed Host listening on ${runtime.url}`);
}
