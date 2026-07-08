import type { DelegatedAccess, TinyCloudNode } from "@tinycloud/node-sdk";
import type { ControlIntentEvent, FeedbackEvent } from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import {
  activateFeedHostDelegation,
  actorIdsMatch,
  createFeedHostNode,
  createFeedHostPolicy,
  FeedDelegationError,
  FEED_HOST_ARTIFACT_DOC_PREFIX,
  FEED_HOST_ARTIFACTS_DB_PATH,
  FEED_HOST_FEED_DB_PATH,
  hasCompleteFeedHostDelegation,
  normalizeActorId,
  type ActivatedFeedDelegation,
  type AcceptedFeedDelegation,
  type FeedHostDelegationPolicy,
} from "./delegation.ts";
import {
  LEGACY_FEED_DB_PATH,
  LEGACY_INTERACTIONS_DB_PATH,
} from "../../artifactory/skills/_shared/lib/feed-v1-migration.ts";
import { FeedHostDelegationStore, liveDelegationResources } from "./delegation-store.ts";
import { seedDefaultFeed } from "./seed.ts";
import { FeedHostStorage, type FeedHostActorStorage } from "./storage.ts";

type JsonBody = Record<string, unknown>;

export type FeedHostServerOptions = {
  port: number;
  hostname: string;
  token?: string;
  tinycloudHost?: string;
  hostPrivateKey?: string;
  seedOnStart?: boolean;
  storage?: FeedHostStorage;
  hostNode?: TinyCloudNode;
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
};

type FeedHostContext = {
  storage: FeedHostStorage;
  policy: FeedHostDelegationPolicy;
  actors: Map<string, ActorState>;
  activateDelegation: NonNullable<FeedHostServerOptions["activateDelegation"]>;
  seedOnStart: boolean;
  delegationStore: FeedHostDelegationStore | null;
};

const JSON_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, X-Feed-Actor-Id",
};

export function startFeedHost(options: FeedHostServerOptions): FeedHostRuntime {
  const storage = options.storage ?? new FeedHostStorage();
  const hostNode =
    options.hostNode ?? createFeedHostNode({ privateKey: options.hostPrivateKey, host: options.tinycloudHost });
  // With a stable host key the node signs into its own TinyCloud space so the
  // delegate DID is the stable did:pkh identity (and the delegation store can
  // write to the host's KV space). Without a key the host keeps its generated
  // session DID and nothing is persisted.
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
  // Persisting delegations only makes sense with a stable host identity: a
  // generated session DID cannot reactivate delegations after a restart.
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
    context ??= {
      storage,
      policy: createFeedHostPolicy(hostNode.did),
      actors,
      activateDelegation,
      seedOnStart: options.seedOnStart !== false,
      delegationStore,
    };
    return context;
  };

  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    // Requests fan out to the upstream TinyCloud node and can exceed Bun's
    // default 10s idle timeout, which would drop the socket mid-request.
    idleTimeout: 120,
    async fetch(request) {
      try {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
        if (!authorized(request, options.token)) return json({ error: { code: "unauthorized", message: "missing or invalid bearer token" } }, 401);
        return await route(request, await getContext());
      } catch (error) {
        if (error instanceof FeedDelegationError) {
          return json({ error: { code: error.code, message: error.message } }, 403);
        }
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: { code: "internal_error", message } }, 500);
      }
    },
  });

  const stop = () => {
    server.stop(true);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  return {
    hostname: server.hostname,
    port: server.port,
    url: `http://${server.hostname}:${server.port}`,
    stop,
  };
}

async function route(request: Request, context: FeedHostContext): Promise<Response> {
  const { storage, policy, actors, activateDelegation, seedOnStart } = context;
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      schema: "tinycloud.sql/schema",
      storage: "tinycloud",
      delegateDID: policy.delegateDID,
      actors: actors.size,
    });
  }

  if (request.method === "GET" && url.pathname === "/delegation-policy") {
    return json(policy);
  }

  if (request.method === "POST" && url.pathname === "/delegations") {
    const body = await requireBody<{ actorId?: string; serializedDelegation: string }>(request, [
      "serializedDelegation",
    ]);
    const accepted = await activateDelegation({
      serializedDelegation: body.serializedDelegation,
      expectedDelegateDID: policy.delegateDID,
    });
    // Delegations bind to the owner identity signed into the delegation
    // (accepted.actorId). A payload actorId can only confirm that identity —
    // never rebind the delegation to another actor namespace.
    if (body.actorId !== undefined && (typeof body.actorId !== "string" || !actorIdsMatch(body.actorId, accepted.actorId))) {
      throw new FeedDelegationError("actorId does not match the delegation owner identity", "actor_mismatch");
    }
    const actorKey = normalizeActorId(accepted.actorId);
    const existing = actors.get(actorKey);
    const resources = [...new Set([...(existing?.resources ?? []), ...accepted.resources])];
    const accessByResource = new Map(existing?.accessByResource);
    for (const resource of accepted.resources) accessByResource.set(resource, accepted.access);
    const state: ActorState = {
      actorId: accepted.actorId,
      acceptedAt: accepted.acceptedAt,
      resources,
      accessByResource,
      storageAccess: existing?.storageAccess,
      ready: existing?.ready,
    };
    actors.set(actorKey, state);
    if (context.delegationStore) {
      await persistAcceptedDelegation(context.delegationStore, policy, actorKey, {
        serializedDelegation: body.serializedDelegation,
        resources: accepted.resources,
        acceptedAt: accepted.acceptedAt,
        expiresAt: accepted.expiresAt,
      });
    }
    if (hasCompleteFeedHostDelegation(state)) await ensureActorReady(storage, state, seedOnStart);
    return json({ accepted: true, actorId: accepted.actorId, resources });
  }

  if (request.method === "GET" && url.pathname === "/admin/state") {
    const actor = await requireActorReady(request, context);
    return json(await storage.debugState(actorStorage(actor)));
  }

  if (request.method === "POST" && url.pathname === "/admin/seed") {
    const actor = await requireActorReady(request, { ...context, seedOnStart: false });
    await seedDefaultFeed(storage, actorStorage(actor));
    return json({ ok: true, state: await storage.debugState(actorStorage(actor)) });
  }

  if (request.method === "GET" && url.pathname === "/feed") {
    const actor = await requireActorReady(request, context);
    const limit = Number(url.searchParams.get("limit") ?? "40");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (!Number.isFinite(limit)) return json({ error: { code: "bad_request", message: "limit must be a number" } }, 400);
    return json(await storage.listFeed(actorStorage(actor), { limit, cursor }));
  }

  const artifactMatch = url.pathname.match(/^\/artifacts\/([^/]+)(\/provenance)?$/);
  if (request.method === "GET" && artifactMatch) {
    const actor = await requireActorReady(request, context);
    const artifactId = decodeURIComponent(artifactMatch[1]);
    const body = artifactMatch[2]
      ? await storage.getProvenance(actorStorage(actor), artifactId)
      : await storage.getArtifact(actorStorage(actor), artifactId);
    if (!body) return json({ error: { code: "not_found", message: `artifact not found: ${artifactId}` } }, 404);
    return json(body);
  }

  if (request.method === "POST" && url.pathname === "/feedback") {
    const event = await requireBody<FeedbackEvent>(request, ["eventId", "artifactId", "actorId", "readerNonce", "signal", "createdAt"]);
    requirePayloadActorMatchesHeader(request, event.actorId);
    const actor = await requireActorReady(request, context, event.actorId);
    await storage.recordFeedback(actorStorage(actor), event);
    return json({ accepted: true, eventId: event.eventId });
  }

  if (request.method === "POST" && url.pathname === "/control-intents") {
    const event = await requireBody<ControlIntentEvent>(request, [
      "eventId",
      "actorId",
      "readerNonce",
      "intentKind",
      "status",
      "targetRef",
      "createdAt",
    ]);
    requirePayloadActorMatchesHeader(request, event.actorId);
    const actor = await requireActorReady(request, context, event.actorId);
    await storage.recordControlIntent(actorStorage(actor), event);
    return json({ accepted: true, eventId: event.eventId });
  }

  return json({ error: { code: "not_found", message: `${request.method} ${url.pathname}` } }, 404);
}

function authorized(request: Request, token: string | undefined): boolean {
  if (!token) return true;
  return request.headers.get("authorization") === `Bearer ${token}`;
}

async function requireActorReady(
  request: Request,
  context: FeedHostContext,
  actorId = request.headers.get("x-feed-actor-id") ?? "",
): Promise<ActorState> {
  const actor = await requireDelegation(context, actorId);
  await ensureActorReady(context.storage, actor, context.seedOnStart);
  return actor;
}

async function requireDelegation(context: FeedHostContext, actorId: string): Promise<ActorState> {
  if (!actorId) throw new FeedDelegationError("missing delegated actor", "malformed");
  const actorKey = normalizeActorId(actorId);
  let delegation = context.actors.get(actorKey);
  if (!hasCompleteFeedHostDelegation(delegation) && context.delegationStore) {
    delegation = (await restoreActorFromStore(context, actorKey)) ?? delegation;
  }
  if (!hasCompleteFeedHostDelegation(delegation)) {
    throw new FeedDelegationError("Feed Host has no complete accepted delegation for actor", "insufficient_policy");
  }
  return delegation;
}

function requirePayloadActorMatchesHeader(request: Request, payloadActorId: string): void {
  const headerActorId = request.headers.get("x-feed-actor-id");
  if (headerActorId && !actorIdsMatch(headerActorId, payloadActorId)) {
    throw new FeedDelegationError("payload actorId does not match the request actor", "actor_mismatch");
  }
}

async function persistAcceptedDelegation(
  store: FeedHostDelegationStore,
  policy: FeedHostDelegationPolicy,
  actorId: string,
  accepted: { serializedDelegation: string; resources: string[]; acceptedAt: string; expiresAt: string },
): Promise<void> {
  const existing = await store.load(actorId);
  const prior =
    existing && existing.delegateDID === policy.delegateDID ? liveDelegationResources(existing) : [];
  const kept = prior.filter((resource) => !accepted.resources.includes(resource.path));
  const added = accepted.resources.map((path) => ({
    path,
    serializedDelegation: accepted.serializedDelegation,
    acceptedAt: accepted.acceptedAt,
    expiresAt: accepted.expiresAt,
  }));
  await store.save({ actorId, delegateDID: policy.delegateDID, resources: [...kept, ...added] });
}

async function restoreActorFromStore(
  context: FeedHostContext,
  actorKey: string,
): Promise<ActorState | null> {
  const store = context.delegationStore;
  if (!store) return null;
  const stored = await store.load(actorKey);
  if (!stored) return null;
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
    await store.save({ ...stored, resources: live });
  }
  try {
    const accessByResource = new Map<string, DelegatedAccess>();
    const resources: string[] = [];
    let actorId = actorKey;
    let acceptedAt = new Date().toISOString();
    for (const resource of live) {
      const accepted = await context.activateDelegation({
        serializedDelegation: resource.serializedDelegation,
        expectedDelegateDID: context.policy.delegateDID,
      });
      // Persisted records must still bind to the identity signed into the
      // delegation; a record stored under another actor's key is pruned.
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
      resources: [...new Set(resources)],
      accessByResource,
    };
    context.actors.set(actorKey, state);
    return state;
  } catch (error) {
    // A persisted delegation the host can no longer accept (expired,
    // re-minted for another DID, malformed, owned by a different actor) is
    // pruned so the actor is asked to delegate again. Transient activation
    // failures propagate.
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
  const documents = actor.accessByResource.get(FEED_HOST_ARTIFACT_DOC_PREFIX);
  if (!artifacts || !feed || !documents) {
    throw new FeedDelegationError("Feed Host delegation is missing activated TinyCloud access", "insufficient_policy");
  }
  const legacyArtifacts = actor.accessByResource.get(LEGACY_FEED_DB_PATH);
  const legacyInteractions = actor.accessByResource.get(LEGACY_INTERACTIONS_DB_PATH);
  actor.storageAccess = {
    artifacts,
    feed,
    documents,
    ...(legacyArtifacts ? { legacyArtifacts } : {}),
    ...(legacyInteractions ? { legacyInteractions } : {}),
  };
  return actor.storageAccess;
}

async function ensureActorReady(storage: FeedHostStorage, actor: ActorState, seedOnStart: boolean): Promise<void> {
  if (!actor.ready) {
    actor.ready = (async () => {
      const access = actorStorage(actor);
      const migration = await storage.bootstrapSchema(access);
      const legacyDataPresent = migration.legacyArtifacts > 0 || migration.legacyInteractions > 0;
      if (seedOnStart && !legacyDataPresent && !(await storage.hasArtifacts(access))) await seedDefaultFeed(storage, access);
    })();
  }
  await actor.ready;
}

async function requireBody<T extends JsonBody>(request: Request, fields: string[]): Promise<T> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Error("request body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("request body must be an object");
  const record = body as JsonBody;
  for (const field of fields) {
    if (typeof record[field] !== "string" || record[field] === "") throw new Error(`${field} is required`);
  }
  return record as T;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function optionsFromEnv(): FeedHostServerOptions {
  return {
    port: Number(process.env.FEED_HOST_PORT ?? "8787"),
    hostname: process.env.FEED_HOST_HOSTNAME ?? "127.0.0.1",
    token: process.env.FEED_HOST_TOKEN || undefined,
    tinycloudHost: process.env.TINYCLOUD_HOST || process.env.VITE_TINYCLOUD_HOST || undefined,
    hostPrivateKey: process.env.FEED_HOST_PRIVATE_KEY || undefined,
    seedOnStart: process.env.FEED_HOST_SEED !== "0",
  };
}

if (import.meta.main) {
  const runtime = startFeedHost(optionsFromEnv());
  console.log(`Feed Host listening on ${runtime.url}`);
}
