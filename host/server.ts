import type { DelegatedAccess } from "@tinycloud/node-sdk";
import type { ControlIntentEvent, FeedbackEvent } from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import {
  activateFeedHostDelegation,
  createFeedHostNode,
  createFeedHostPolicy,
  FeedDelegationError,
  FEED_HOST_ARTIFACT_DOC_PREFIX,
  FEED_HOST_ARTIFACTS_DB_PATH,
  FEED_HOST_FEED_DB_PATH,
  hasCompleteFeedHostDelegation,
  type ActivatedFeedDelegation,
  type AcceptedFeedDelegation,
  type FeedHostDelegationPolicy,
} from "./delegation.ts";
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

const JSON_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, X-Feed-Actor-Id",
};

export function startFeedHost(options: FeedHostServerOptions): FeedHostRuntime {
  const storage = options.storage ?? new FeedHostStorage();
  const hostNode = createFeedHostNode({ privateKey: options.hostPrivateKey, host: options.tinycloudHost });
  const policy = createFeedHostPolicy(hostNode.did);
  const activateDelegation =
    options.activateDelegation ??
    ((input) =>
      activateFeedHostDelegation({
        node: hostNode,
        serializedDelegation: input.serializedDelegation,
        expectedDelegateDID: input.expectedDelegateDID,
      }));
  const actors = new Map<string, ActorState>();

  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    async fetch(request) {
      try {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
        if (!authorized(request, options.token)) return json({ error: { code: "unauthorized", message: "missing or invalid bearer token" } }, 401);
        return await route(request, storage, policy, actors, activateDelegation, options.seedOnStart !== false);
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

async function route(
  request: Request,
  storage: FeedHostStorage,
  policy: FeedHostDelegationPolicy,
  actors: Map<string, ActorState>,
  activateDelegation: NonNullable<FeedHostServerOptions["activateDelegation"]>,
  seedOnStart: boolean,
): Promise<Response> {
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
    const body = await requireBody<{ actorId: string; serializedDelegation: string }>(request, [
      "actorId",
      "serializedDelegation",
    ]);
    const accepted = await activateDelegation({
      serializedDelegation: body.serializedDelegation,
      expectedDelegateDID: policy.delegateDID,
    });
    const existing = actors.get(body.actorId);
    const resources = [...new Set([...(existing?.resources ?? []), ...accepted.resources])];
    const accessByResource = new Map(existing?.accessByResource);
    for (const resource of accepted.resources) accessByResource.set(resource, accepted.access);
    const state: ActorState = {
      actorId: body.actorId,
      acceptedAt: accepted.acceptedAt,
      resources,
      accessByResource,
      storageAccess: existing?.storageAccess,
      ready: existing?.ready,
    };
    actors.set(body.actorId, state);
    if (hasCompleteFeedHostDelegation(state)) await ensureActorReady(storage, state, seedOnStart);
    return json({ accepted: true, actorId: body.actorId, resources });
  }

  if (request.method === "GET" && url.pathname === "/admin/state") {
    const actor = await requireActorReady(request, storage, actors, seedOnStart);
    return json(await storage.debugState(actorStorage(actor)));
  }

  if (request.method === "POST" && url.pathname === "/admin/seed") {
    const actor = await requireActorReady(request, storage, actors, false);
    await seedDefaultFeed(storage, actorStorage(actor));
    return json({ ok: true, state: await storage.debugState(actorStorage(actor)) });
  }

  if (request.method === "GET" && url.pathname === "/feed") {
    const actor = await requireActorReady(request, storage, actors, seedOnStart);
    const limit = Number(url.searchParams.get("limit") ?? "40");
    const cursor = url.searchParams.get("cursor") ?? undefined;
    if (!Number.isFinite(limit)) return json({ error: { code: "bad_request", message: "limit must be a number" } }, 400);
    return json(await storage.listFeed(actorStorage(actor), { limit, cursor }));
  }

  const artifactMatch = url.pathname.match(/^\/artifacts\/([^/]+)(\/provenance)?$/);
  if (request.method === "GET" && artifactMatch) {
    const actor = await requireActorReady(request, storage, actors, seedOnStart);
    const artifactId = decodeURIComponent(artifactMatch[1]);
    const body = artifactMatch[2]
      ? await storage.getProvenance(actorStorage(actor), artifactId)
      : await storage.getArtifact(actorStorage(actor), artifactId);
    if (!body) return json({ error: { code: "not_found", message: `artifact not found: ${artifactId}` } }, 404);
    return json(body);
  }

  if (request.method === "POST" && url.pathname === "/feedback") {
    const event = await requireBody<FeedbackEvent>(request, ["eventId", "artifactId", "actorId", "readerNonce", "signal", "createdAt"]);
    const actor = await requireActorReady(request, storage, actors, seedOnStart, event.actorId);
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
    const actor = await requireActorReady(request, storage, actors, seedOnStart, event.actorId);
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
  storage: FeedHostStorage,
  actors: Map<string, ActorState>,
  seedOnStart: boolean,
  actorId = request.headers.get("x-feed-actor-id") ?? "",
): Promise<ActorState> {
  const actor = requireDelegation(actors, actorId);
  await ensureActorReady(storage, actor, seedOnStart);
  return actor;
}

function requireDelegation(
  actors: Map<string, ActorState>,
  actorId: string,
): ActorState {
  if (!actorId) throw new FeedDelegationError("missing delegated actor", "malformed");
  const delegation = actors.get(actorId);
  if (!hasCompleteFeedHostDelegation(delegation)) {
    throw new FeedDelegationError("Feed Host has no complete accepted delegation for actor", "insufficient_policy");
  }
  return delegation;
}

function actorStorage(actor: ActorState): FeedHostActorStorage {
  if (actor.storageAccess) return actor.storageAccess;
  const artifacts = actor.accessByResource.get(FEED_HOST_ARTIFACTS_DB_PATH);
  const feed = actor.accessByResource.get(FEED_HOST_FEED_DB_PATH);
  const documents = actor.accessByResource.get(FEED_HOST_ARTIFACT_DOC_PREFIX);
  if (!artifacts || !feed || !documents) {
    throw new FeedDelegationError("Feed Host delegation is missing activated TinyCloud access", "insufficient_policy");
  }
  actor.storageAccess = { artifacts, feed, documents };
  return actor.storageAccess;
}

async function ensureActorReady(storage: FeedHostStorage, actor: ActorState, seedOnStart: boolean): Promise<void> {
  if (!actor.ready) {
    actor.ready = (async () => {
      const access = actorStorage(actor);
      await storage.bootstrapSchema(access);
      if (seedOnStart && !(await storage.hasArtifacts(access))) await seedDefaultFeed(storage, access);
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
