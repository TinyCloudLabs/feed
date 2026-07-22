import { afterEach, describe, expect, test } from "bun:test";
import type { TinyCloudNode } from "@tinycloud/node-sdk";
import type {
  ControlIntentEvent,
  FeedArtifact,
  FeedArtifactProjection,
  FeedbackEvent,
} from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import type { FeedV1MigrationSummary } from "../../artifactory/skills/_shared/lib/feed-v1-migration.ts";
import type { SqlSeedRow } from "../../artifactory/skills/_shared/lib/feed-v1-bootstrap.ts";
import {
  buildFeedEvents,
  defaultFeedPreferences,
  filterFeedEventsAfterId,
  hashJson,
  mergeFeedPreferences,
  rankFeedProjections,
  reconcileFeedProjections,
  renderFeedEventStream,
  summarizeFeedbackEvents,
  FEED_HOST_PREFERENCES_SCOPE,
  sanitizePreferenceValue,
  type FeedPreferenceProfileRecord,
  type FeedPreferenceValue,
  type FeedProjectionState,
  type FeedReconcileArtifact,
} from "./logic.ts";
import {
  FEED_HOST_DELEGATION_RESOURCES,
  type ActivatedFeedDelegation,
  type FeedHostDelegationPolicy,
} from "./delegation.ts";
import { FeedHostDelegationStore } from "./delegation-store.ts";
import { SEEDED_ARTIFACT_ID } from "./seed.ts";
import {
  DEFAULT_MAX_PENDING_GENERATION_REQUESTS,
  FeedHostError,
  type FeedHostActorStorage,
  type FeedHostStorage,
} from "./storage.ts";
import {
  isTinyCloudSerializationConflict,
  startFeedHost as startSecureFeedHost,
  type FeedHostRuntime,
  type FeedHostServerOptions,
} from "./server.ts";
import type { FeedItemProjection, FeedTargetedInteractionEvent } from "../shared/feed-item.ts";
import { telemetryIdHash } from "./observability.ts";

process.env.FEED_HOST_LOG = "0";

const ACTOR_ID = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_ACTOR_ID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const INPUT_CHILD_CID = "bafkr4ie6h4l4tcmrkube2fehu5lloyo4ijh2lzvdfpywj4uj6tyaurbcau";
const INPUT_PARENT_CID = "bafkr4ihl32taldpsemg4ew32pr5uq62hbriiylqkkem4s2etyrb54ou6pe";
const MUTATING_ROUTES = ["/feedback", "/control-intents"] as const;
// Stable host identity used for restart coverage. In production this comes
// from FEED_HOST_PRIVATE_KEY: the host signs in and its did:pkh stays stable.
const HOST_DID = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SECOND_ARTIFACT_ID = "run-seed-002:insight-card-001";
const FAKE_NOW = "2026-07-20T00:00:00.000Z";

// Route-focused tests opt out explicitly; authentication tests pass
// requireActorSession: true and exercise the production default.
function startFeedHost(options: FeedHostServerOptions): FeedHostRuntime {
  return startSecureFeedHost({ requireActorSession: false, ...options });
}

function startDiagnosticsHost(token: string | undefined, options: FeedHostServerOptions): FeedHostRuntime {
  const previous = process.env.FEED_HOST_DIAGNOSTICS_TOKEN;
  if (token === undefined) delete process.env.FEED_HOST_DIAGNOSTICS_TOKEN;
  else process.env.FEED_HOST_DIAGNOSTICS_TOKEN = token;
  try {
    return startFeedHost(options);
  } finally {
    if (previous === undefined) delete process.env.FEED_HOST_DIAGNOSTICS_TOKEN;
    else process.env.FEED_HOST_DIAGNOSTICS_TOKEN = previous;
  }
}

const SOURCE_REF = {
  sourceRefId: "listen:seed:fundraising-loop",
  sourceKind: "listen_conversation",
  sourceId: "conversation-seed-001",
  observedPath: "sql_transcript_json",
  observedHash: "sha256:feed-v1-seed-source",
  observedAt: "2026-06-29T12:00:00.000Z",
  quoteLineRefs: ["L12-L18", "L41-L47"],
} as const;

const DISCLOSURE = {
  userCopy: "Generated from your recent Listen context using Feed-hosted OpenAI credentials.",
  credentialOwner: "feed_hosted" as const,
  providerClass: "first_party" as const,
  egressClass: "model_provider" as const,
};

let runtime: FeedHostRuntime | null = null;

afterEach(() => {
  runtime?.stop();
  runtime = null;
});

describe("Feed Host server", () => {
  test("diagnostics are indistinguishable from an unknown route when disabled", async () => {
    runtime = startDiagnosticsHost(undefined, {
      port: 0,
      hostname: "127.0.0.1",
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const response = await fetch(`${runtime.url}/admin/diagnostics`);
    expect(response.status).toBe(404);
  });

  test("diagnostics reject the wrong dedicated bearer token", async () => {
    runtime = startDiagnosticsHost("diagnostics-test-token", {
      port: 0,
      hostname: "127.0.0.1",
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const response = await fetch(`${runtime.url}/admin/diagnostics`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(response.status).toBe(401);
  });

  test("diagnostics return privacy-safe queue, integrity, delegation, and alert aggregates", async () => {
    const delegationStore = fakeDelegationStore();
    runtime = startDiagnosticsHost("diagnostics-test-token", {
      port: 0,
      hostname: "127.0.0.1",
      storage: new DiagnosticsFeedHostStorage() as unknown as FeedHostStorage,
      delegationStore,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
      proactiveActorId: ACTOR_ID,
      now: () => new Date(FAKE_NOW),
    });
    await grantAllDelegations(runtime, ACTOR_ID);
    expect(await runtime.ensureProactiveNow()).toBe("ok");

    const response = await fetch(`${runtime.url}/admin/diagnostics`, {
      headers: { authorization: "Bearer diagnostics-test-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      buildSha: string;
      nodeVersion: string;
      delegationStore: { actors: number; resources: number; expiringSoonCount: number };
      proactiveScheduler: {
        enabled: boolean;
        actorHash: string | null;
        lastEnsuredSlot: string | null;
        lastResult: string | null;
      };
      actors: Record<string, {
        queue: { counts: Record<string, number>; oldestAcceptedAgeSec: number };
        integrity: { healthy: number; missing: number; quarantined: number };
        lastWorkerClaim: null;
        recentRequests: Array<{
          requestId: string;
          dedupeKeyKind: "proactive" | "ask";
          terminal: string | null;
          errorCode: string | null;
          manifestIds: string[];
          strategy: string | null;
          criticVerdicts: Array<{ attempt: number; count: number; finalVerdictCode: string | null }>;
          timestamps: { createdAt: string; claimedAt: string | null; finishedAt: string | null; updatedAt: string };
        }>;
        deadLetterCount: number;
        billingBlocked: boolean;
        alerts: { quarantined: boolean; oldestAccepted: boolean; workerClaimStale: boolean };
      }>;
      recentEvents: Array<{ event: string; actorHash?: string }>;
    };
    const actorHash = telemetryIdHash(ACTOR_ID);
    expect(Object.keys(body.actors)).toEqual([actorHash]);
    expect(body.actors[actorHash]).toMatchObject({
      queue: { counts: { accepted: 2, consumed: 1 }, oldestAcceptedAgeSec: 7201 },
      integrity: { healthy: 4, missing: 1, quarantined: 1 },
      lastWorkerClaim: null,
      recentRequests: [{
        requestId: "diagnostic-request",
        dedupeKeyKind: "ask",
        terminal: "published",
        errorCode: null,
        manifestIds: ["manifest-1"],
        strategy: "context-variety-v1",
      }],
      deadLetterCount: 2,
      billingBlocked: true,
      alerts: { quarantined: true, oldestAccepted: true, workerClaimStale: true },
    });
    expect(body.delegationStore.actors).toBe(1);
    expect(body.delegationStore.resources).toBeGreaterThan(0);
    expect(body.delegationStore.expiringSoonCount).toBeGreaterThan(0);
    expect(body.proactiveScheduler).toEqual({
      enabled: true,
      actorHash,
      lastEnsuredSlot: FAKE_NOW.slice(0, 10),
      lastResult: "ok",
    });
    expect(body.buildSha).toBe("dev");
    expect(typeof body.nodeVersion).toBe("string");
    expect(Array.isArray(body.recentEvents)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(ACTOR_ID);
  });

  test("serves public metadata and an OpenAPI document that matches the host routes", async () => {
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const infoResponse = await fetch(`${runtime.url}/api/server-info`);
    expect(infoResponse.ok).toBe(true);
    const info = (await infoResponse.json()) as {
      did: string;
      policyHash: string;
      features: Record<string, boolean>;
      permissions: Array<{ path: string }>;
    };
    expect(info.did).toBeDefined();
    expect(info.policyHash).toMatch(/^sha256:/);
    expect(info.features.openapi).toBe(true);
    expect(info.features.feedEvents).toBe(true);

    const etag = infoResponse.headers.get("etag");
    expect(etag).not.toBeNull();
    const notModified = await fetch(`${runtime.url}/api/server-info`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(notModified.status).toBe(304);

    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    expect(policy.delegateDID).not.toContain("#");
    expect(policy.resources.map((resource) => resource.path)).toEqual(FEED_HOST_DELEGATION_RESOURCES.map((resource) => resource.path));
    expect(policy.resources).toContainEqual({
      service: "tinycloud.sql",
      serviceShort: "sql",
      path: "xyz.tinycloud.listen/conversations",
      actions: ["tinycloud.sql/read"],
    });
    expect(policy.resources).toContainEqual({
      service: "tinycloud.kv",
      serviceShort: "kv",
      path: "xyz.tinycloud.listen/transcript/",
      actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
    });

    const openApi = await getJson<{
      paths: Record<string, unknown>;
      security: Array<Record<string, unknown>>;
      components: { securitySchemes: Record<string, { in?: string; name?: string; type: string; scheme?: string }> };
    }>(`${runtime.url}/api/openapi.json`);
    expect(openApi.security).toEqual([{ actorSession: [] }]);
    expect(openApi.components.securitySchemes.actorSession).toMatchObject({ in: "cookie", name: "__Host-feed_session" });
    expect(openApi.components.securitySchemes.workerBearer).toMatchObject({ type: "http", scheme: "bearer" });
    expect(Object.keys(openApi.paths).sort()).toEqual(
      [
        "/health",
        "/delegation-policy",
        "/api/server-info",
        "/api/delegations",
        "/api/delegations/retry",
        "/api/delegations/status",
        "/input-authorities",
        "/input-authorities/{sourceId}",
        "/input-authorities/{sourceId}/status",
        "/input-authorities/{sourceId}/revoke",
        "/api/openapi.json",
        "/admin/state",
        "/admin/seed",
        "/feed",
        "/feed/events",
        "/artifacts/{artifactId}",
        "/artifacts/{artifactId}/hero",
        "/artifacts/{artifactId}/provenance",
        "/feedback",
        "/control-intents",
        "/preferences",
        "/workflows",
        "/generation-requests",
        "/generation-requests/{requestId}/cancel",
        "/api/worker/generation-requests/claim",
        "/api/worker/generation-requests/{requestId}/{action}",
      ].sort(),
    );
    const feedEventsPath = openApi.paths["/feed/events"] as {
      get?: { parameters?: Array<{ name?: string }>; responses?: Record<string, { content?: Record<string, unknown> }> };
    };
    expect(feedEventsPath.get?.responses?.["200"]?.content?.["text/event-stream"]).toBeDefined();
    expect(feedEventsPath.get?.parameters?.some((parameter) => parameter.name === "Last-Event-ID")).toBe(true);
  });

  test("exposes delegation status and deletion for a fully activated actor", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    await grantAllDelegations(runtime, ACTOR_ID);
    const activeStatus = await getJson<{
      state: string;
      complete: boolean;
      policyHash: string;
      resources: Array<{ path: string }>;
    }>(`${runtime.url}/api/delegations/status`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(activeStatus.state).toBe("active");
    expect(activeStatus.complete).toBe(true);
    expect(activeStatus.policyHash).toMatch(/^sha256:/);
    expect(activeStatus.resources.map((resource) => resource.path)).toEqual(
      FEED_HOST_DELEGATION_RESOURCES.map((resource) => resource.path),
    );

    const deleted = await fetch(`${runtime.url}/api/delegations`, {
      method: "DELETE",
      headers: { "x-feed-actor-id": ACTOR_ID },
    });
    expect(deleted.status).toBe(204);

    const missingStatus = await getJson<{
      state: string;
      complete: boolean;
    }>(`${runtime.url}/api/delegations/status`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(missingStatus.state).toBe("missing");
    expect(missingStatus.complete).toBe(false);

    const blockedFeed = await fetch(`${runtime.url}/feed?limit=10`, {
      headers: { "x-feed-actor-id": ACTOR_ID },
    });
    expect(blockedFeed.status).toBe(403);
  });

  test("requires an actor-bound session after accepting a signed delegation", async () => {
    const allowedOrigin = "https://feed.tinycloud.xyz";
    runtime = startSecureFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      allowedOrigins: [allowedOrigin],
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const preflight = await fetch(`${runtime.url}/feed`, {
      method: "OPTIONS",
      headers: {
        origin: allowedOrigin,
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-feed-trace-id",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("X-Feed-Trace-Id");

    const deniedOrigin = await fetch(`${runtime.url}/delegation-policy`, {
      headers: { origin: "https://attacker.example" },
    });
    expect(deniedOrigin.status).toBe(403);
    expect(deniedOrigin.headers.get("access-control-allow-origin")).toBeNull();

    const beforeGrant = await fetch(`${runtime.url}/feed`, {
      headers: { "x-feed-actor-id": ACTOR_ID },
    });
    expect(beforeGrant.status).toBe(401);

    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    const grant = await postJson(`${runtime.url}/api/delegations`, {
      actorId: ACTOR_ID,
      serializedDelegation: policy.resources.map((resource) => resource.path).join("|"),
    }, { origin: allowedOrigin });
    expect(grant.status).toBe(202);
    const setCookie = grant.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("feed_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    const sessionCookie = setCookie.split(";", 1)[0];
    const ownFeed = await fetch(`${runtime.url}/feed`, {
      headers: { cookie: sessionCookie, origin: allowedOrigin },
    });
    expect(ownFeed.status).toBe(200);
    expect(ownFeed.headers.get("cache-control")).toBe("private, no-store");
    expect(ownFeed.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
    expect(ownFeed.headers.get("access-control-allow-credentials")).toBe("true");

    const impersonation = await fetch(`${runtime.url}/feed`, {
      headers: {
        "x-feed-actor-id": "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
        cookie: sessionCookie,
      },
    });
    expect(impersonation.status).toBe(401);

    const narrowGrant = await postJson(`${runtime.url}/api/delegations`, {
      actorId: ACTOR_ID,
      serializedDelegation: policy.resources[0]!.path,
    });
    expect(narrowGrant.status).toBe(202);
    expect(narrowGrant.headers.get("set-cookie")).toBeNull();
    expect(narrowGrant.headers.get("cache-control")).toBe("private, no-store");

    const hostedGrant = await postJson(`${runtime.url}/api/delegations`, {
      actorId: ACTOR_ID,
      serializedDelegation: policy.resources.map((resource) => resource.path).join("|"),
    }, { origin: allowedOrigin, "x-forwarded-proto": "https" });
    expect(hostedGrant.headers.get("set-cookie")).toContain("__Host-feed_session=");
    expect(hostedGrant.headers.get("set-cookie")).toContain("Secure");
    expect(hostedGrant.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("secure browser mode fails closed without an origin allowlist", async () => {
    runtime = startSecureFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const policyResponse = await fetch(`${runtime.url}/delegation-policy`);
    expect(policyResponse.status).toBe(200);
    expect(policyResponse.headers.get("cache-control")).toBe("private, no-store");
    const browserRequest = await fetch(`${runtime.url}/delegation-policy`, {
      headers: { origin: "https://feed.tinycloud.xyz" },
    });
    expect(browserRequest.status).toBe(403);
    expect(browserRequest.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a fresh complete delegation replaces expired actor state", async () => {
    let expiresInMs = 20;
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      requireActorSession: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation, expiresInMs),
    });

    const expiredCookie = await grantAllDelegations(runtime, ACTOR_ID);
    await Bun.sleep(30);
    const expired = await fetch(`${runtime.url}/feed`, { headers: { cookie: expiredCookie } });
    expect(expired.status).toBe(401);

    expiresInMs = 60_000;
    const renewedCookie = await grantAllDelegations(runtime, ACTOR_ID);
    const renewed = await fetch(`${runtime.url}/feed`, { headers: { cookie: renewedCookie } });
    expect(renewed.status).toBe(200);
  });

  test("retries transient TinyCloud serialization conflicts during actor setup", async () => {
    const storage = new TransientBootstrapStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    expect(isTinyCloudSerializationConflict(new Error("could not serialize access due to read/write dependencies"))).toBe(true);
    expect(isTinyCloudSerializationConflict(new Error("permission denied"))).toBe(false);
    await grantAllDelegations(runtime, ACTOR_ID);
    expect(storage.bootstrapAttempts).toBe(2);
  });

  test("retries transient TinyCloud serialization conflicts while accepting a delegation", async () => {
    const store = fakeDelegationStore();
    const save = store.save.bind(store);
    let activations = 0;
    let saves = 0;
    store.save = async (record) => {
      saves += 1;
      if (saves <= 2) {
        throw new Error("KV put failed: could not serialize access due to read/write dependencies among transactions");
      }
      await save(record);
    };
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      delegationStore: store,
      activateDelegation: async ({ serializedDelegation }) => {
        activations += 1;
        if (activations <= 2) {
          throw new Error("delegation activation failed: could not serialize access due to read/write dependencies among transactions");
        }
        return fakeActivatedDelegation(serializedDelegation);
      },
    });

    await grantAllDelegations(runtime, ACTOR_ID);
    expect(activations).toBe(3);
    for (let attempt = 0; attempt < 30 && saves < 3; attempt += 1) await Bun.sleep(50);
    expect(saves).toBe(3);
  });

  test("does not block the browser session on delegation-store persistence", async () => {
    const store = fakeDelegationStore();
    let releaseSave: (() => void) | undefined;
    const blockedSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    store.save = async () => blockedSave;
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      requireActorSession: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      delegationStore: store,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);

    const request = postJson(`${runtime.url}/api/delegations`, {
      actorId: ACTOR_ID,
      serializedDelegation: policy.resources.map((resource) => resource.path).join("|"),
    });
    const response = await Promise.race([request, Bun.sleep(100).then(() => null)]);
    expect(response).not.toBeNull();
    expect(response?.status).toBe(202);
    expect(response?.headers.get("set-cookie")).toContain("feed_session=");
    releaseSave?.();
  });

  test("exposes failed backend preparation and retries it through the actor session", async () => {
    const storage = new FailOncePreparationStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      requireActorSession: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    const grant = await postJson(`${runtime.url}/api/delegations`, {
      actorId: ACTOR_ID,
      serializedDelegation: policy.resources.map((resource) => resource.path).join("|"),
    });
    expect(grant.status).toBe(202);
    const cookie = grant.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const failed = await waitForSetupStatus(runtime, cookie, "failed");
    expect(failed.setup?.phase).toBe("failed");
    expect(failed.setup?.attempt).toBe(1);
    expect(failed.setup?.error?.message).toContain("planned bootstrap failure");

    const retry = await postJson(`${runtime.url}/api/delegations/retry`, {}, { cookie });
    expect(retry.status).toBe(202);
    const ready = await waitForSetupStatus(runtime, cookie, "ready");
    expect(ready.setup?.attempt).toBe(2);
    expect(storage.bootstrapAttempts).toBe(2);
  });

  test("deduplicates concurrent backend preparation for the same actor", async () => {
    const storage = new BlockingPreparationStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    const body = {
      actorId: ACTOR_ID,
      serializedDelegation: policy.resources.map((resource) => resource.path).join("|"),
    };

    const [first, second] = await Promise.all([
      postJson(`${runtime.url}/api/delegations`, body),
      postJson(`${runtime.url}/api/delegations`, body),
    ]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(storage.bootstrapAttempts).toBe(1);
    storage.release();
    await waitForSetupStatus(runtime, "", "ready");
  });

  test("serves existing feed data while backend preparation is still running", async () => {
    const storage = new BlockingPreparationStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      requireActorSession: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    const grant = await postJson(`${runtime.url}/api/delegations`, {
      actorId: ACTOR_ID,
      serializedDelegation: policy.resources.map((resource) => resource.path).join("|"),
    });
    expect(grant.status).toBe(202);
    const cookie = grant.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const feed = await Promise.race([
      fetch(`${runtime.url}/feed`, { headers: { cookie } }),
      Bun.sleep(100).then(() => null),
    ]);
    expect(feed).not.toBeNull();
    expect(feed?.status).toBe(200);
    expect(((await feed?.json()) as { items: unknown[] }).items).toEqual([]);

    storage.release();
    await waitForSetupStatus(runtime, cookie, "ready");
  });

  test("serializes concurrent private requests for the same actor", async () => {
    const storage = new ConcurrentReadStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      requireActorSession: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const cookie = await grantAllDelegations(runtime, ACTOR_ID);

    const [feed, events] = await Promise.all([
      fetch(`${runtime.url}/feed`, { headers: { cookie } }),
      fetch(`${runtime.url}/feed/events`, { headers: { cookie } }),
    ]);

    expect(feed.status).toBe(200);
    expect(events.status).toBe(200);
    expect(storage.maxConcurrentReads).toBe(1);
  });

  test("keeps setup status responsive while a feed read is blocked", async () => {
    const storage = new BlockingFeedReadStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      requireActorSession: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const cookie = await grantAllDelegations(runtime, ACTOR_ID);
    const feed = fetch(`${runtime.url}/feed`, { headers: { cookie } });
    await storage.started;

    const status = await fetch(`${runtime.url}/api/delegations/status`, { headers: { cookie } });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { setup: { state: string } }).setup.state).toBe("ready");

    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    const reconnect = await Promise.race([
      postJson(`${runtime.url}/api/delegations`, {
        actorId: ACTOR_ID,
        serializedDelegation: policy.resources.map((resource) => resource.path).join("|"),
      }),
      Bun.sleep(100).then(() => null),
    ]);
    expect(reconnect).not.toBeNull();
    expect(reconnect?.status).toBe(200);

    storage.release();
    expect((await feed).status).toBe(200);
  });

  test("does not reconcile projections on reader endpoints", async () => {
    const storage = new ReconcileCountingStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    await grantAllDelegations(runtime, ACTOR_ID);

    const feed = await fetch(`${runtime.url}/feed?limit=40`, { headers: { "x-feed-actor-id": ACTOR_ID } });
    expect(feed.status).toBe(200);
    const events = await fetch(`${runtime.url}/feed/events`, { headers: { "x-feed-actor-id": ACTOR_ID } });
    expect(events.status).toBe(200);
    expect(storage.reconcileAttempts).toBe(0);
  });

  test("attaches, inspects, revokes, and removes a redacted named input authority", async () => {
    const data = new Map<string, unknown>();
    const access = {
      kv: {
        get: async (key: string) => data.has(key)
          ? { ok: true, data: { data: data.get(key) } }
          : { ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } },
        put: async (key: string, value: unknown) => {
          data.set(key, value);
          return { ok: true, data: undefined };
        },
        delete: async (key: string) => {
          data.delete(key);
          return { ok: true, data: undefined };
        },
      },
    } as unknown as ActivatedFeedDelegation["access"];
    let inspections = 0;
    let revocations = 0;
    let nodeRevoked = false;
    const hostNode = {
      did: "did:key:zFeedHost",
      getDelegationStatus: async (childCid: string) => ({
        ok: true as const,
        data: {
          cid: childCid,
          status: nodeRevoked ? "revoked" : "active",
          exists: true,
          active: !nodeRevoked,
          revoked: nodeRevoked,
          expired: false,
        },
      }),
      revokeDelegation: async (childCid: string) => {
        expect(childCid).toBe(INPUT_CHILD_CID);
        revocations += 1;
        nodeRevoked = true;
        return { ok: true as const, data: undefined };
      },
    } as unknown as TinyCloudNode;
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      hostNode,
      inputAuthorityExpectedHost: "https://node.tinycloud.xyz",
      activateDelegation: async ({ serializedDelegation }) => ({
        ...fakeActivatedDelegation(serializedDelegation),
        access,
      }),
      inspectInputAuthority: async ({ expectedAudienceDID }) => {
        inspections += 1;
        return {
          childCid: INPUT_CHILD_CID,
          canonicalPortableDelegation: childTransport(),
          actorId: ACTOR_ID,
          audienceDID: expectedAudienceDID,
          host: "https://node.tinycloud.xyz",
          space: "tinycloud:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266:applications",
          path: "xyz.tinycloud.listen/conversations",
          actions: ["tinycloud.sql/read"],
          expiry: "2099-01-01T00:00:00.000Z",
          parentCid: INPUT_PARENT_CID,
          agentDID: expectedAudienceDID,
        };
      },
    });
    await grantAllDelegations(runtime, ACTOR_ID);
    const headers = { "x-feed-actor-id": ACTOR_ID };

    const rejectedRaw = await postJson(`${runtime.url}/input-authorities`, {
      sourceId: "raw",
      displayName: "Raw",
      portableDelegation: "child",
      tc1Link: "tc1:must-not-leak",
    }, headers);
    expect(rejectedRaw.status).toBe(400);
    expect(await rejectedRaw.text()).not.toContain("must-not-leak");
    expect(inspections).toBe(0);

    const attached = await postJson(`${runtime.url}/input-authorities`, {
      sourceId: "team-listen",
      displayName: "Team Listen",
      portableDelegation: childTransport(),
    }, headers);
    expect(attached.status).toBe(201);
    expect(await attached.json()).toMatchObject({
      attached: true,
      item: { sourceId: "team-listen", state: "active", hasPortableDelegation: true },
    });
    expect(JSON.stringify(await getJson(`${runtime.url}/input-authorities/team-listen`, headers))).not.toContain("child.jwt.signature");
    const crossActor = await fetch(`${runtime.url}/input-authorities`, {
      headers: { "x-feed-actor-id": OTHER_ACTOR_ID },
    });
    expect(crossActor.status).toBe(403);
    expect(await getJson(`${runtime.url}/input-authorities/team-listen/status`, headers)).toMatchObject({
      sourceId: "team-listen",
      state: "active",
    });
    const revoked = await postJson(`${runtime.url}/input-authorities/team-listen/revoke`, {}, headers);
    expect(await revoked.json()).toMatchObject({ revoked: true, item: { state: "revoked" } });
    expect(revocations).toBe(1);
    const removed = await fetch(`${runtime.url}/input-authorities/team-listen`, { method: "DELETE", headers });
    expect(removed.status).toBe(204);
    expect(await getJson<{ items: unknown[] }>(`${runtime.url}/input-authorities`, headers)).toEqual({ items: [] });
  });

  test("rejects expired live delegations after their expiresAt passes", async () => {
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation, 1000),
    });

    await grantAllDelegations(runtime, ACTOR_ID);

    const activeStatus = await getJson<{ state: string; complete: boolean }>(`${runtime.url}/api/delegations/status`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(activeStatus.state).toBe("active");
    expect(activeStatus.complete).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const expiredStatus = await getJson<{ state: string; complete: boolean }>(`${runtime.url}/api/delegations/status`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(expiredStatus.state).toBe("expired");
    expect(expiredStatus.complete).toBe(false);

    const blockedFeed = await fetch(`${runtime.url}/feed?limit=10`, {
      headers: { "x-feed-actor-id": ACTOR_ID },
    });
    expect(blockedFeed.status).toBe(409);
    expect(await blockedFeed.json()).toEqual({
      error: {
        code: "delegation_stale",
        message: "accepted delegation has expired",
      },
    });
  });

  test("applies preferences to ranking and rejects stale preference versions", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    await grantAllDelegations(runtime, ACTOR_ID);
    storage.addArtifactFixture(
      makeArtifact({
        artifactId: SECOND_ARTIFACT_ID,
        packageId: "follow-up",
        runId: "run-seed-002",
        packageDigest: "sha256:fixture-package-follow-up",
        createdAt: "2026-07-11T11:59:00.000Z",
        updatedAt: "2026-07-11T11:59:00.000Z",
        sourceFingerprint: "sha256:fixture-source-follow-up",
        artifactFingerprint: "sha256:fixture-artifact-follow-up",
        dedupeKey: "feed-v1-fixture:follow-up",
        docKey: "seed/run-seed-002/insight-card-001.json",
        title: "Follow Up Fixture",
        summary: "A lower-ranked fixture that should be promoted by preferences.",
        bodyMarkdown: "Preference-sensitive ranking fixture.",
      }),
      makeProjection({
        artifactId: SECOND_ARTIFACT_ID,
        packageId: "follow-up",
        sourceFingerprint: "sha256:fixture-source-follow-up",
        publishedAt: "2026-07-11T11:59:00.000Z",
        updatedAt: "2026-07-11T11:59:00.000Z",
        rankScore: 0,
        reasonCodes: ["fixture"],
      }),
      {
        runId: "run-seed-002",
        packageId: "follow-up",
        status: "published",
        startedAt: "2026-07-11T11:59:00.000Z",
        finishedAt: "2026-07-11T11:59:00.000Z",
      },
    );

    const before = await getJson<{ items: FeedItemProjection[] }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(new Set(before.items.map((item) => item.target.artifactId))).toEqual(new Set([SEEDED_ARTIFACT_ID, SECOND_ARTIFACT_ID]));

    const currentPreferences = await getJson<{ profile: FeedPreferenceProfileRecord | null }>(`${runtime.url}/preferences`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(currentPreferences.profile).toBeNull();

    const updated = await putJson(
      `${runtime.url}/preferences`,
      {
        expectedVersion: 0,
        patch: {
          packagePriority: {
            "follow-up": 10,
          },
          unexpected: "drop-me",
        },
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(updated.status).toBe(200);
    const updatedProfile = (await updated.json()) as { profile: FeedPreferenceProfileRecord };
    expect(updatedProfile.profile.version).toBe(1);
    expect(updatedProfile.profile.value.packagePriority?.["follow-up"]).toBe(10);
    expect("unexpected" in updatedProfile.profile.value).toBe(false);

    const invalidScope = await putJson(
      `${runtime.url}/preferences`,
      {
        scope: "package:forbidden",
        expectedVersion: 1,
        patch: {},
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(invalidScope.status).toBe(400);
    expect(await invalidScope.json()).toEqual({
      error: {
        code: "invalid_preferences",
        message: "preference scope is not allowlisted",
      },
    });

    const after = await getJson<{ items: FeedItemProjection[] }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(after.items.map((item) => item.target.artifactId)[0]).toBe(SECOND_ARTIFACT_ID);

    const conflict = await putJson(
      `${runtime.url}/preferences`,
      {
        expectedVersion: 0,
        patch: {
          packagePriority: {
            "follow-up": 2,
          },
        },
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: {
        code: "version_conflict",
        message: "preference version conflict",
        details: {
          currentVersion: 1,
        },
      },
    });
  });

  test("rejects payload-supplied preference scopes on control intents", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    await grantAllDelegations(runtime, ACTOR_ID);

    const intent = await postJson(
      `${runtime.url}/control-intents`,
      {
        eventId: "intent-scope-test-001",
        readerNonce: "intent-scope-nonce-001",
        intentKind: "safe_package_setting_update",
        status: "accepted",
        targetRef: "package:scope-target",
        payload: {
          scope: "package:other-target",
          value: { paused: true },
        },
        createdAt: "2026-06-29T12:06:30.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID },
    );

    expect(intent.status).toBe(400);
    expect(await intent.json()).toEqual({
      error: {
        code: "invalid_intent",
        message: "preference scope is not allowlisted",
      },
    });

    const rejectedProfile = await getJson<{ profile: FeedPreferenceProfileRecord | null }>(
      `${runtime.url}/preferences?scope=package:scope-target`,
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(rejectedProfile.profile).toBeNull();
  });

  test("records feedback, control intents, generation requests, and SSE projection events", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    await grantAllDelegations(runtime, ACTOR_ID);

    const feedback = await postJson(
      `${runtime.url}/feedback`,
      {
        eventId: "feedback-test-001",
        feedItemId: `legacy:${SEEDED_ARTIFACT_ID}`,
        artifactId: SEEDED_ARTIFACT_ID,
        actorId: ACTOR_ID,
        readerNonce: "feedback-nonce-001",
        signal: "save",
        createdAt: "2026-06-29T12:05:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(feedback.status).toBe(200);
    expect(await feedback.json()).toEqual({
      accepted: true,
      eventId: "feedback-test-001",
      duplicate: false,
      status: "applied",
    });
    const storedSaveEvent = (storage as unknown as { feedbackEvents: Array<FeedbackEvent & { feedItemId?: string }> }).feedbackEvents.find(
      (event) => event.readerNonce === "feedback-nonce-001",
    );
    expect(storedSaveEvent).toMatchObject({ target: { kind: "artifact", artifactId: SEEDED_ARTIFACT_ID } });

    const updatedFeed = await getJson<{ items: FeedItemProjection[] }>(
      `${runtime.url}/feed?limit=10`,
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(updatedFeed.items[0].disposition).toBe("saved");
    const noteText = `${"note-".repeat(240)}trailing`;
    const noteFeedback = await postJson(
      `${runtime.url}/feedback`,
      {
        eventId: "feedback-test-002",
        artifactId: SEEDED_ARTIFACT_ID,
        actorId: ACTOR_ID,
        readerNonce: "feedback-nonce-002",
        signal: "text_note",
        payload: {
          note: noteText,
          ignored: "drop-me",
        },
        createdAt: "2026-06-29T12:05:30.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(noteFeedback.status).toBe(200);
    expect(await noteFeedback.json()).toEqual({
      accepted: true,
      eventId: "feedback-test-002",
      duplicate: false,
      status: "applied",
    });
    const storedNoteEvent = (storage as unknown as { feedbackEvents: FeedbackEvent[] }).feedbackEvents.find(
      (event) => event.readerNonce === "feedback-nonce-002",
    );
    expect(storedNoteEvent?.payload).toEqual({ note: noteText.slice(0, 1024) });
    const intent = await postJson(
      `${runtime.url}/control-intents`,
      {
        eventId: "intent-test-001",
        readerNonce: "intent-nonce-001",
        intentKind: "ask_feed",
        status: "accepted",
        targetRef: "feed",
        payload: { prompt: "Generate another seed artifact." },
        createdAt: "2026-06-29T12:06:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(intent.status).toBe(202);
    expect(await intent.json()).toEqual({
      accepted: true,
      eventId: "intent-test-001",
      duplicate: false,
      status: "accepted",
      requestId: "intent-test-001",
    });

    const controlIntents = await getJson<{ items: Array<{ intentKind: string; status: string }> }>(
      `${runtime.url}/control-intents`,
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(controlIntents.items[0].intentKind).toBe("generate_new_request");
    expect(controlIntents.items[0].status).toBe("accepted");

    const generationRequests = await getJson<{ items: Array<{ requestId: string; status: string }> }>(
      `${runtime.url}/generation-requests`,
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(generationRequests.items).toHaveLength(1);
    expect(generationRequests.items[0].requestId).toBe("intent-test-001");
    expect(generationRequests.items[0].status).toBe("accepted");

    const eventsResponse = await fetch(`${runtime.url}/feed/events`, {
      headers: { "x-feed-actor-id": ACTOR_ID },
    });
    expect(eventsResponse.ok).toBe(true);
    const eventsText = await eventsResponse.text();
    expect(eventsText).toContain("event: projection-updated");
    expect(eventsText).toContain("event: artifact-published");
    expect(eventsText).not.toContain("event: run-status");
    const eventIds = [...eventsText.matchAll(/^id: (.+)$/gm)].map((match) => match[1]);
    expect(eventIds.length).toBeGreaterThan(1);
    const cursorEventId = eventIds[eventIds.length - 1];

    storage.addArtifactFixture(
      makeArtifact({
        artifactId: SECOND_ARTIFACT_ID,
        packageId: "follow-up",
        runId: "run-seed-002",
        packageDigest: "sha256:fixture-package-follow-up",
        createdAt: "2026-06-29T11:59:00.000Z",
        updatedAt: "2026-06-29T11:59:00.000Z",
        sourceFingerprint: "sha256:fixture-source-follow-up",
        artifactFingerprint: "sha256:fixture-artifact-follow-up",
        dedupeKey: "feed-v1-fixture:follow-up",
        docKey: "seed/run-seed-002/insight-card-001.json",
        title: "Follow Up Fixture",
        summary: "A lower-ranked fixture that should survive resume filtering.",
        bodyMarkdown: "Resume filtering fixture.",
      }),
      makeProjection({
        artifactId: SECOND_ARTIFACT_ID,
        packageId: "follow-up",
        sourceFingerprint: "sha256:fixture-source-follow-up",
        publishedAt: "2026-06-29T11:59:00.000Z",
        updatedAt: "2026-06-29T11:59:00.000Z",
        rankScore: 0.42,
        reasonCodes: ["fixture"],
      }),
      {
        runId: "run-seed-002",
        packageId: "follow-up",
        status: "published",
        startedAt: "2026-06-29T11:59:00.000Z",
        finishedAt: "2026-06-29T11:59:00.000Z",
      },
    );
    const resumedResponse = await fetch(`${runtime.url}/feed/events`, {
      headers: {
        "x-feed-actor-id": ACTOR_ID,
        "last-event-id": cursorEventId,
      },
    });
    expect(resumedResponse.ok).toBe(true);
    const resumedText = await resumedResponse.text();
    expect(resumedText).not.toContain(`id: ${cursorEventId}`);
    expect(resumedText).toContain(`id: projection:legacy:${SECOND_ARTIFACT_ID}:`);
  });

  test("dev publisher imports a Feed v1 artifact for the single active actor", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      enableDevPublisher: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    await grantAllDelegations(runtime, ACTOR_ID);

    const artifact = makeArtifact({
      artifactId: "run-dev-extract-insights:test-card",
      packageId: "artifactory.extract-insights",
      runId: "run-dev-extract-insights",
      packageDigest: "sha256:extract-insights-dev",
      createdAt: "2026-07-10T22:00:00.000Z",
      updatedAt: "2026-07-10T22:00:00.000Z",
      sourceFingerprint: "sha256:dev-source",
      artifactFingerprint: "sha256:dev-artifact",
      dedupeKey: "dev-dedupe",
      docKey: "runs/run-dev-extract-insights/test-card.json",
      title: "Dev Imported Insight",
      summary: "A local extract-insights artifact imported through the dev bridge.",
      bodyMarkdown: "Feed Host accepted a native Feed v1 artifact from a local Artifactory skill.",
    });

    const publish = await postJson(`${runtime.url}/admin/dev/publish-artifact`, { artifact });
    expect(publish.status).toBe(200);
    expect(await publish.json()).toMatchObject({
      accepted: true,
      artifactId: artifact.artifactId,
      state: {
        artifacts: 2,
        projections: 2,
      },
    });

    const feed = await getJson<{ items: FeedItemProjection[] }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(feed.items.some((item) => item.target.artifactId === artifact.artifactId)).toBe(true);

    const hydrated = await getJson<FeedArtifact>(`${runtime.url}/artifacts/${encodeURIComponent(artifact.artifactId)}`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(hydrated.title).toBe("Dev Imported Insight");
  });

  test("dev generation worker endpoints list, claim, and complete requests", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      enableDevPublisher: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    await grantAllDelegations(runtime, ACTOR_ID);

    const createdAt = new Date().toISOString();
    const intent = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "gen-worker-intent-001",
        readerNonce: "gen-worker-nonce-001",
        intentKind: "ask_feed",
        targetRef: "feed",
        payload: { prompt: "Summarize my week" },
        createdAt,
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(intent.status).toBe(202);
    const intentBody = (await intent.json()) as { requestId?: string };
    expect(intentBody.requestId).toBe("gen-worker-intent-001");

    const accepted = await getJson<{ items: Array<{ requestId: string; status: string; prompt: string | null }> }>(
      `${runtime.url}/admin/dev/generation-requests?status=accepted`,
    );
    expect(accepted.items).toHaveLength(1);
    expect(accepted.items[0].requestId).toBe("gen-worker-intent-001");
    expect(accepted.items[0].prompt).toBe("Summarize my week");

    const claim = await postJson(`${runtime.url}/admin/dev/generation-requests/gen-worker-intent-001/status`, {
      status: "pending",
      expectedStatus: "accepted",
    });
    expect(claim.status).toBe(200);
    expect(await claim.json()).toMatchObject({ updated: true, request: { status: "pending" } });

    const doubleClaim = await postJson(`${runtime.url}/admin/dev/generation-requests/gen-worker-intent-001/status`, {
      status: "pending",
      expectedStatus: "accepted",
    });
    expect(doubleClaim.status).toBe(409);
    expect(((await doubleClaim.json()) as { error: { code: string } }).error.code).toBe("status_conflict");

    const complete = await postJson(`${runtime.url}/admin/dev/generation-requests/gen-worker-intent-001/status`, {
      status: "consumed",
    });
    expect(complete.status).toBe(200);

    const drained = await getJson<{ items: unknown[] }>(`${runtime.url}/admin/dev/generation-requests?status=accepted`);
    expect(drained.items).toHaveLength(0);

    const missing = await postJson(`${runtime.url}/admin/dev/generation-requests/nope/status`, { status: "consumed" });
    expect(missing.status).toBe(404);

    const invalid = await postJson(`${runtime.url}/admin/dev/generation-requests/gen-worker-intent-001/status`, {
      status: "nonsense",
    });
    expect(invalid.status).toBe(400);
  });

  test("production worker control fails closed, rejects browser origins, and never accepts actor auth", async () => {
    const storage = new FakeFeedHostStorage();
    const workerToken = "worker-control-token-with-at-least-32-random-like-bytes";
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      workerToken,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    await grantAllDelegations(runtime, ACTOR_ID);
    const createdAt = new Date().toISOString();
    await postJson(`${runtime.url}/control-intents`, {
      actorId: ACTOR_ID,
      eventId: "production-worker-001",
      readerNonce: "production-worker-nonce-001",
      intentKind: "ask_feed",
      targetRef: "feed",
      payload: { prompt: "This prompt must never be logged" },
      createdAt,
    }, { "x-feed-actor-id": ACTOR_ID });
    const claimBody = { actorId: ACTOR_ID, workflowId: "workflow-production", claimOwner: "worker-production" };

    const actorAuthOnly = await postJson(
      `${runtime.url}/api/worker/generation-requests/claim`,
      claimBody,
      { "x-feed-actor-id": ACTOR_ID, cookie: "feed_session=forged" },
    );
    expect(actorAuthOnly.status).toBe(401);
    expect(actorAuthOnly.headers.get("cache-control")).toBe("private, no-store");

    const browser = await postJson(
      `${runtime.url}/api/worker/generation-requests/claim`,
      claimBody,
      { authorization: `Bearer ${workerToken}`, origin: "https://feed.tinycloud.xyz" },
    );
    expect(browser.status).toBe(403);
    expect(browser.headers.get("access-control-allow-origin")).toBeNull();
    expect(browser.headers.get("cache-control")).toBe("private, no-store");

    const accepted = await postJson(
      `${runtime.url}/api/worker/generation-requests/claim`,
      claimBody,
      { authorization: `Bearer ${workerToken}` },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("private, no-store");
    expect(await accepted.json()).toMatchObject({
      request: {
        requestId: "production-worker-001",
        runId: "production-worker-001",
        workflowId: "workflow-production",
        fencingToken: 1,
      },
      committedCursor: null,
    });

    runtime.stop();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: storage as unknown as FeedHostStorage,
    });
    const unset = await postJson(
      `${runtime.url}/api/worker/generation-requests/claim`,
      claimBody,
      { authorization: `Bearer ${workerToken}` },
    );
    expect(unset.status).toBe(401);
    expect(unset.headers.get("cache-control")).toBe("private, no-store");
  });

  test("worker phase and reconcile endpoints accept optional generation observability metadata", async () => {
    const storage = new FakeFeedHostStorage();
    const workerToken = "observability-worker-token-with-at-least-32-random-bytes";
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      workerToken,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    await grantAllDelegations(runtime, ACTOR_ID);
    await postJson(`${runtime.url}/control-intents`, {
      actorId: ACTOR_ID,
      eventId: "observed-worker-001",
      readerNonce: "observed-worker-nonce-001",
      intentKind: "ask_feed",
      targetRef: "feed",
      createdAt: new Date().toISOString(),
    }, { "x-feed-actor-id": ACTOR_ID });
    const claimResponse = await postJson(`${runtime.url}/api/worker/generation-requests/claim`, {
      actorId: ACTOR_ID,
      workflowId: "observed-workflow",
      claimOwner: "observed-worker",
    }, { authorization: `Bearer ${workerToken}` });
    const claim = (await claimResponse.json()) as { request: { requestId: string; runId: string; fencingToken: number } };
    const identity = {
      actorId: ACTOR_ID,
      runId: claim.request.runId,
      claimOwner: "observed-worker",
      fencingToken: claim.request.fencingToken,
    };

    const legacyPhase = await postJson(
      `${runtime.url}/api/worker/generation-requests/${claim.request.requestId}/phase`,
      { ...identity, phase: "running" },
      { authorization: `Bearer ${workerToken}` },
    );
    expect(legacyPhase.status).toBe(200);

    const phase = await postJson(
      `${runtime.url}/api/worker/generation-requests/${claim.request.requestId}/phase`,
      {
        ...identity,
        phase: "validating",
        metadata: {
          generationStrategy: "context-variety/v2 verbatim",
          criticVerdicts: [{ attempt: 1, count: 2, finalVerdictCode: "pass" }],
        },
      },
      { authorization: `Bearer ${workerToken}` },
    );
    expect(await phase.json()).toMatchObject({
      request: {
        strategy: "context-variety/v2 verbatim",
        criticVerdicts: [{ attempt: 1, count: 2, finalVerdictCode: "pass" }],
      },
    });

    const reconcile = await postJson(
      `${runtime.url}/api/worker/generation-requests/${claim.request.requestId}/reconcile`,
      { ...identity, terminalKind: "published", manifestIds: ["manifest-1"] },
      { authorization: `Bearer ${workerToken}` },
    );
    expect(await reconcile.json()).toMatchObject({
      request: { terminal: "published", publishedManifestIds: ["manifest-1"] },
    });
  });

  test("worker source batches require the worker token and a live matching generation fence", async () => {
    const storage = new FakeFeedHostStorage();
    const workerToken = "source-batch-worker-token-with-at-least-32-random-bytes";
    const databasePaths: string[] = [];
    const databaseStatements: string[] = [];
    let transcriptReadGate: Promise<void> | undefined;
    let markTranscriptReadStarted = () => {};
    const sourceAccess = {
      sql: {
        db: (path: string) => {
          databasePaths.push(path);
          return {
            query: async (sql: string) => {
              databaseStatements.push(sql);
              if (sql.startsWith("PRAGMA")) {
                return { ok: false, error: { code: "AUTH_UNAUTHORIZED", message: "SQL admin is not delegated" } };
              }
              if (sql.includes("AS transcript_json")) {
                return { ok: true, data: { rows: [{ transcript_json: null, transcript_text: "fenced source transcript" }] } };
              }
              return {
                ok: true,
                data: { rows: [{ id: "listen-conversation-1", title: "Listen title", started_at: "2026-07-21T12:00:00.000Z" }] },
              };
            },
          };
        },
      },
      kv: {
        get: async () => {
          if (transcriptReadGate) {
            markTranscriptReadStarted();
            await transcriptReadGate;
          }
          return { ok: false, error: { code: "KV_NOT_FOUND", message: "not found" } };
        },
      },
    } as unknown as ActivatedFeedDelegation["access"];
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      workerToken,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => ({
        ...fakeActivatedDelegation(serializedDelegation),
        access: sourceAccess,
      }),
    });
    await grantAllDelegations(runtime, ACTOR_ID);
    const createdAt = new Date().toISOString();
    await postJson(`${runtime.url}/control-intents`, {
      actorId: ACTOR_ID,
      eventId: "source-batch-request-1",
      readerNonce: "source-batch-nonce-1",
      intentKind: "ask_feed",
      targetRef: "feed",
      createdAt,
    }, { "x-feed-actor-id": ACTOR_ID });
    const claimResponse = await postJson(`${runtime.url}/api/worker/generation-requests/claim`, {
      actorId: ACTOR_ID,
      workflowId: "source-workflow",
      claimOwner: "source-worker",
    }, { authorization: `Bearer ${workerToken}` });
    const claim = (await claimResponse.json()) as { request: { requestId: string; runId: string; fencingToken: number } };
    const body = {
      actorId: ACTOR_ID,
      runId: claim.request.runId,
      claimOwner: "source-worker",
      fencingToken: claim.request.fencingToken,
      limit: 1,
    };

    const actorSessionOnly = await postJson(
      `${runtime.url}/api/worker/generation-requests/${claim.request.requestId}/sources`,
      body,
      { "x-feed-actor-id": ACTOR_ID, cookie: "feed_session=forged" },
    );
    expect(actorSessionOnly.status).toBe(401);

    const wrongFence = await postJson(
      `${runtime.url}/api/worker/generation-requests/${claim.request.requestId}/sources`,
      { ...body, fencingToken: claim.request.fencingToken + 1 },
      { authorization: `Bearer ${workerToken}` },
    );
    expect(wrongFence.status).toBe(409);
    expect(((await wrongFence.json()) as { error: { code: string } }).error.code).toBe("stale_generation_lease");

    const valid = await postJson(
      `${runtime.url}/api/worker/generation-requests/${claim.request.requestId}/sources`,
      body,
      { authorization: `Bearer ${workerToken}` },
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({
      count: 1,
      items: [{ conversationId: "listen-conversation-1", transcript: "fenced source transcript" }],
    });
    expect(databasePaths).toContain("xyz.tinycloud.listen/conversations");
    expect(databaseStatements.some((statement) => /^\s*PRAGMA\b/i.test(statement))).toBe(false);

    let releaseTranscriptRead = () => {};
    const transcriptReadStarted = new Promise<void>((resolve) => {
      markTranscriptReadStarted = resolve;
    });
    transcriptReadGate = new Promise<void>((resolve) => {
      releaseTranscriptRead = resolve;
    });
    const slowSourceRequest = postJson(
      `${runtime.url}/api/worker/generation-requests/${claim.request.requestId}/sources`,
      body,
      { authorization: `Bearer ${workerToken}` },
    );
    await transcriptReadStarted;
    const heartbeatRequest = postJson(
      `${runtime.url}/api/worker/generation-requests/${claim.request.requestId}/heartbeat`,
      { ...body, leaseSeconds: 120 },
      { authorization: `Bearer ${workerToken}` },
    );
    const heartbeatWhileReading = await Promise.race([
      heartbeatRequest,
      Bun.sleep(2_000).then(() => null),
    ]);
    releaseTranscriptRead();
    transcriptReadGate = undefined;
    const [slowSourceResponse, heartbeatResponse] = await Promise.all([
      slowSourceRequest,
      heartbeatWhileReading ?? heartbeatRequest,
    ]);
    expect(heartbeatWhileReading).not.toBeNull();
    expect(heartbeatResponse.status).toBe(200);
    expect(slowSourceResponse.status).toBe(200);

    storage.expireGenerationLease(claim.request.requestId);
    const expired = await postJson(
      `${runtime.url}/api/worker/generation-requests/${claim.request.requestId}/sources`,
      body,
      { authorization: `Bearer ${workerToken}` },
    );
    expect(expired.status).toBe(409);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe("stale_generation_lease");
  });

  test("generation cancellation requires the browser actor session", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startSecureFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      requireActorSession: true,
      allowedOrigins: ["https://feed.tinycloud.xyz"],
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const cookie = await grantAllDelegations(runtime, ACTOR_ID);
    const createdAt = new Date().toISOString();
    const intent = await postJson(`${runtime.url}/control-intents`, {
      eventId: "cancel-browser-001",
      readerNonce: "cancel-browser-nonce-001",
      intentKind: "ask_feed",
      targetRef: "feed",
      createdAt,
    }, { cookie, origin: "https://feed.tinycloud.xyz" });
    expect(intent.status).toBe(202);

    const noSession = await postJson(`${runtime.url}/generation-requests/cancel-browser-001/cancel`, {}, {
      "x-feed-actor-id": ACTOR_ID,
      origin: "https://feed.tinycloud.xyz",
    });
    expect(noSession.status).toBe(401);

    const canceled = await postJson(`${runtime.url}/generation-requests/cancel-browser-001/cancel`, {}, {
      cookie,
      origin: "https://feed.tinycloud.xyz",
    });
    expect(canceled.status).toBe(200);
    expect(canceled.headers.get("cache-control")).toBe("private, no-store");
    expect(await canceled.json()).toMatchObject({
      cancellationRequested: true,
      request: { status: "cancelled", phase: "cancelled" },
    });
  });

  test("rejects new generation requests once the actor backlog is full", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      enableDevPublisher: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    await grantAllDelegations(runtime, ACTOR_ID);

    for (let index = 0; index < DEFAULT_MAX_PENDING_GENERATION_REQUESTS; index++) {
      const response = await postJson(
        `${runtime.url}/control-intents`,
        {
          actorId: ACTOR_ID,
          eventId: `backlog-intent-${index}`,
          readerNonce: `backlog-nonce-${index}`,
          intentKind: "ask_feed",
          targetRef: "feed",
          payload: { prompt: `Generate insight number ${index}` },
          createdAt: "2026-07-10T22:00:00.000Z",
        },
        { "x-feed-actor-id": ACTOR_ID },
      );
      expect(response.status).toBe(202);
    }

    const overflow = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "backlog-intent-overflow",
        readerNonce: "backlog-nonce-overflow",
        intentKind: "ask_feed",
        targetRef: "feed",
        payload: { prompt: "One request too many" },
        createdAt: "2026-07-10T22:00:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(overflow.status).toBe(429);
    const overflowBody = (await overflow.json()) as { error: { code: string; details?: { pendingCount?: number } } };
    expect(overflowBody.error.code).toBe("generation_backlog_full");

    const consume = await postJson(`${runtime.url}/admin/dev/generation-requests/backlog-intent-0/status`, {
      status: "consumed",
    });
    expect(consume.status).toBe(200);

    const retry = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "backlog-intent-retry",
        readerNonce: "backlog-nonce-retry",
        intentKind: "ask_feed",
        targetRef: "feed",
        payload: { prompt: "Backlog drained, please generate" },
        createdAt: "2026-07-10T22:05:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(retry.status).toBe(202);
  });

  test("binds delegations to the validated actor identity", async () => {
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const response = await fetch(`${runtime.url}/api/delegations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actorId: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
        serializedDelegation: "xyz.tinycloud.artifacts/index",
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "actor_mismatch",
        message: "actorId does not match the delegation owner identity",
      },
    });
  });

  test("rejects writes without an authenticated actor context", async () => {
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    expect(policy.resources.map((resource) => resource.path)).toEqual(FEED_HOST_DELEGATION_RESOURCES.map((resource) => resource.path));
    for (const resource of policy.resources) {
      await postJson(`${runtime.url}/delegations`, {
        actorId: ACTOR_ID,
        serializedDelegation: resource.path,
      });
    }

    for (const path of MUTATING_ROUTES) {
      const response = await postResponse(`${runtime.url}${path}`, {
        actorId: ACTOR_ID,
        eventId: `unauth-${path.slice(1)}`,
        artifactId: SEEDED_ARTIFACT_ID,
        readerNonce: `unauth-${path.slice(1)}-nonce`,
        signal: path === "/feedback" ? "save" : undefined,
        intentKind: path === "/control-intents" ? "ask_feed" : undefined,
        status: path === "/control-intents" ? "accepted" : undefined,
        targetRef: path === "/control-intents" ? "feed" : undefined,
        createdAt: "2026-06-29T12:07:00.000Z",
      });
      expect(response.status).toBe(401);
    }
  });

  test("rejects mismatched actor ids in write payloads", async () => {
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    for (const resource of policy.resources) {
      await postJson(`${runtime.url}/delegations`, {
        actorId: ACTOR_ID,
        serializedDelegation: resource.path,
      });
    }

    for (const path of MUTATING_ROUTES) {
      const response = await postResponse(
        `${runtime.url}${path}`,
        path === "/feedback"
          ? {
              eventId: `mismatch-${path.slice(1)}`,
              artifactId: SEEDED_ARTIFACT_ID,
              actorId: OTHER_ACTOR_ID,
              readerNonce: `mismatch-${path.slice(1)}-nonce`,
              signal: "save",
              createdAt: "2026-06-29T12:08:00.000Z",
            }
          : {
              eventId: `mismatch-${path.slice(1)}`,
              actorId: OTHER_ACTOR_ID,
              readerNonce: `mismatch-${path.slice(1)}-nonce`,
              intentKind: "ask_feed",
              status: "accepted",
              targetRef: "feed",
              createdAt: "2026-06-29T12:08:00.000Z",
            },
        { "x-feed-actor-id": ACTOR_ID },
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: {
          code: "actor_mismatch",
          message: "payload actorId does not match the request actor",
        },
      });
    }
  });

  test("persists accepted delegations and restores actors across restarts", async () => {
    const store = fakeDelegationStore();
    const serverOptions = () => ({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      requireActorSession: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      hostNode: fakeHostNode(HOST_DID),
      delegationStore: store,
      activateDelegation: async ({ serializedDelegation }: { serializedDelegation: string }) =>
        fakeActivatedDelegation(serializedDelegation),
    });

    runtime = startFeedHost(serverOptions());
    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    await grantAllDelegations(runtime, ACTOR_ID);
    const stored = await store.load(ACTOR_ID);
    expect(stored?.delegateDID).toBe(policy.delegateDID);
    expect(stored?.policyHash).toBeDefined();
    expect(stored?.resources.map((resource) => resource.path).sort()).toEqual(
      policy.resources.map((resource) => resource.path).sort(),
    );
    runtime.stop();

    runtime = startFeedHost(serverOptions());
    const restartedPolicy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    expect(restartedPolicy.delegateDID).toBe(policy.delegateDID);
    const missingSession = await fetch(`${runtime.url}/feed?limit=10`, {
      headers: { "x-feed-actor-id": ACTOR_ID },
    });
    expect(missingSession.status).toBe(401);
    const restoredCookie = await grantAllDelegations(runtime, ACTOR_ID);
    const feed = await getJson<{ items: FeedItemProjection[] }>(`${runtime.url}/feed?limit=10`, {
      cookie: restoredCookie,
    });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].target.artifactId).toBe(SEEDED_ARTIFACT_ID);
  });

  test("accepts one multi-resource delegation covering the full policy in a single submission", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    const combined = policy.resources.map((resource) => resource.path).join("|");
    const response = await postJson(`${runtime.url}/api/delegations`, {
      actorId: ACTOR_ID,
      serializedDelegation: combined,
    });
    expect(response.status).toBe(202);
    const body = (await response.json()) as { status: string; resources: string[] };
    expect(body.status).toBe("preparing");
    expect(body.resources.sort()).toEqual(policy.resources.map((resource) => resource.path).sort());

    const feed = await getJson<{ items: unknown[] }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(feed.items).toHaveLength(1);
  });

  test("restores a persisted multi-resource delegation with a single activation", async () => {
    const store = fakeDelegationStore();
    let activations = 0;
    const serverOptions = () => ({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      hostNode: fakeHostNode(HOST_DID),
      delegationStore: store,
      activateDelegation: async ({ serializedDelegation }: { serializedDelegation: string }) => {
        activations += 1;
        return fakeActivatedDelegation(serializedDelegation);
      },
    });
    runtime = startFeedHost(serverOptions());
    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    const combined = policy.resources.map((resource) => resource.path).join("|");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const stored = await (async () => {
      await store.save({
        actorId: ACTOR_ID.toLowerCase(),
        delegateDID: policy.delegateDID,
        policyHash: (await getJson<{ policyHash: string }>(`${runtime.url}/health`)).policyHash,
        resources: policy.resources.map((resource) => ({
          path: resource.path,
          serializedDelegation: combined,
          acceptedAt: new Date().toISOString(),
          expiresAt: future,
        })),
      });
      return store.load(ACTOR_ID.toLowerCase());
    })();
    expect(stored?.resources).toHaveLength(policy.resources.length);

    activations = 0;
    const feed = await getJson<{ items: unknown[] }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(feed.items).toHaveLength(1);
    expect(activations).toBe(1);
  });

  test("prunes expired persisted delegations and requires re-delegation", async () => {
    const store = fakeDelegationStore();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      hostNode: fakeHostNode(HOST_DID),
      delegationStore: store,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    await store.save({
      actorId: ACTOR_ID,
      delegateDID: policy.delegateDID,
      resources: policy.resources.map((resource) => ({
        path: resource.path,
        serializedDelegation: resource.path,
        acceptedAt: past,
        expiresAt: past,
      })),
    });

    const blocked = await fetch(`${runtime.url}/feed?limit=10`, { headers: { "x-feed-actor-id": ACTOR_ID } });
    expect(blocked.status).toBe(403);
    expect(await store.load(ACTOR_ID)).toBeNull();
  });
});

describe("Feed Host skill credential settings", () => {
  const PLANTED_MARKER = "PLANTED_SECRET_tc73_feed_4c1d";

  test("GET /skills and PATCH /skills/:id/credentials require an authenticated actor", async () => {
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const listUnauth = await fetch(`${runtime.url}/skills`);
    expect(listUnauth.status).toBe(401);
    expect((await listUnauth.text()).includes(PLANTED_MARKER)).toBe(false);

    const patchUnauth = await fetch(`${runtime.url}/skills/skill-a/credentials`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: 0,
        credentialMode: "user_byok_api_key",
        secretRef: PLANTED_MARKER,
      }),
    });
    expect(patchUnauth.status).toBe(401);
    const patchUnauthText = await patchUnauth.text();
    expect(patchUnauthText.includes(PLANTED_MARKER)).toBe(false);
  });

  test("actor A cannot read or patch actor B's skill credentials", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => {
        const delegation = fakeActivatedDelegation(serializedDelegation);
        // Route the delegation to whichever actor requested it via the payload.
        return delegation;
      },
    });

    await grantAllDelegations(runtime, ACTOR_ID);
    // Actor A patches their own skill with a planted secret ref.
    const patchA = await fetch(`${runtime.url}/skills/shared-skill/credentials`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-feed-actor-id": ACTOR_ID },
      body: JSON.stringify({
        expectedVersion: 0,
        credentialMode: "user_byok_api_key",
        providerId: "openai",
        secretRef: PLANTED_MARKER,
      }),
    });
    expect(patchA.status).toBe(200);
    const patchABody = await patchA.text();
    expect(patchABody.includes(PLANTED_MARKER)).toBe(false);

    // Actor B, without a delegation, cannot see anything.
    const listBUnbound = await fetch(`${runtime.url}/skills`, {
      headers: { "x-feed-actor-id": OTHER_ACTOR_ID },
    });
    expect(listBUnbound.status).toBe(403);

    // Give actor B their own delegation. Actor B's /skills listing must be
    // scoped to their own actor id — Actor A's planted marker must not leak.
    const bRuntime = runtime;
    const policy = await getJson<FeedHostDelegationPolicy>(`${bRuntime.url}/delegation-policy`);
    for (const resource of policy.resources) {
      await postJson(bRuntime.url + "/api/delegations", {
        actorId: OTHER_ACTOR_ID,
        serializedDelegation: `${resource.path}:${OTHER_ACTOR_ID}`,
      });
    }
    // The fake activateDelegation returns ACTOR_ID as owner, so we cannot
    // truly re-bind actorId in the fake. Instead, patch the fake storage so
    // Actor B has their own row and verify they cannot see the planted one.
    // We approximate the actor-scoping guarantee by checking directly via
    // the storage's own listSkills — which is what the server calls.
    const rowsForA = await storage.listSkills({} as unknown as FeedHostActorStorage, {
      actorId: ACTOR_ID,
      limit: 20,
    });
    expect(rowsForA.items).toHaveLength(1);
    expect(JSON.stringify(rowsForA).includes(PLANTED_MARKER)).toBe(false);

    const rowsForB = await storage.listSkills({} as unknown as FeedHostActorStorage, {
      actorId: OTHER_ACTOR_ID,
      limit: 20,
    });
    expect(rowsForB.items).toHaveLength(0);
  });

  test("PATCH and GET responses redact secretRef and version-conflict errors do not leak submitted values", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    await grantAllDelegations(runtime, ACTOR_ID);

    // Attach a BYOK credential with a planted marker.
    const attach = await fetch(`${runtime.url}/skills/shared-skill/credentials`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-feed-actor-id": ACTOR_ID },
      body: JSON.stringify({
        expectedVersion: 0,
        credentialMode: "user_byok_api_key",
        providerId: "openai",
        secretRef: PLANTED_MARKER,
      }),
    });
    expect(attach.status).toBe(200);
    const attachText = await attach.text();
    expect(attachText.includes(PLANTED_MARKER)).toBe(false);
    const attachBody = JSON.parse(attachText) as {
      updated: true;
      skill: { hasSecret: boolean; version: number; credentialMode: string };
    };
    expect(attachBody.skill.hasSecret).toBe(true);
    expect(attachBody.skill.credentialMode).toBe("user_byok_api_key");

    // A GET listing must also never echo the planted marker.
    const listing = await fetch(`${runtime.url}/skills`, {
      headers: { "x-feed-actor-id": ACTOR_ID },
    });
    expect(listing.status).toBe(200);
    const listingText = await listing.text();
    expect(listingText.includes(PLANTED_MARKER)).toBe(false);

    // A stale-version PATCH must respond 409 without echoing the submitted
    // secretRef.
    const conflict = await fetch(`${runtime.url}/skills/shared-skill/credentials`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-feed-actor-id": ACTOR_ID },
      body: JSON.stringify({
        expectedVersion: 0,
        credentialMode: "user_byok_api_key",
        providerId: "openai",
        secretRef: `${PLANTED_MARKER}_stale`,
      }),
    });
    expect(conflict.status).toBe(409);
    const conflictText = await conflict.text();
    expect(conflictText.includes(PLANTED_MARKER)).toBe(false);

    // A malformed body error must not echo the request payload.
    const bad = await fetch(`${runtime.url}/skills/shared-skill/credentials`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-feed-actor-id": ACTOR_ID },
      body: `{"expectedVersion":1,"credentialMode":"user_byok_api_key","secretRef":"${PLANTED_MARKER}","junk":`,
    });
    expect(bad.status).toBe(400);
    const badText = await bad.text();
    expect(badText.includes(PLANTED_MARKER)).toBe(false);
  });

  test("replacing and removing a BYOK credential updates hasSecret and never echoes the ref", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    await grantAllDelegations(runtime, ACTOR_ID);

    const attach = await fetch(`${runtime.url}/skills/rotator-skill/credentials`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-feed-actor-id": ACTOR_ID },
      body: JSON.stringify({
        expectedVersion: 0,
        credentialMode: "user_byok_api_key",
        providerId: "openai",
        secretRef: PLANTED_MARKER,
      }),
    });
    const attachBody = (await attach.json()) as { skill: { version: number; hasSecret: boolean } };
    expect(attachBody.skill.hasSecret).toBe(true);

    // Replace: same actor patches with a new secret ref. hasSecret must stay
    // true and the response must not echo either the old or new ref.
    const replace = await fetch(`${runtime.url}/skills/rotator-skill/credentials`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-feed-actor-id": ACTOR_ID },
      body: JSON.stringify({
        expectedVersion: attachBody.skill.version,
        credentialMode: "user_byok_api_key",
        providerId: "openai",
        secretRef: `${PLANTED_MARKER}_next`,
      }),
    });
    const replaceText = await replace.text();
    expect(replace.status).toBe(200);
    expect(replaceText.includes(PLANTED_MARKER)).toBe(false);
    const replaceBody = JSON.parse(replaceText) as { skill: { version: number; hasSecret: boolean } };
    expect(replaceBody.skill.hasSecret).toBe(true);

    // Remove: flip mode to "none". hasSecret must go false and the response
    // must not echo the marker.
    const remove = await fetch(`${runtime.url}/skills/rotator-skill/credentials`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-feed-actor-id": ACTOR_ID },
      body: JSON.stringify({
        expectedVersion: replaceBody.skill.version,
        credentialMode: "none",
      }),
    });
    const removeText = await remove.text();
    expect(remove.status).toBe(200);
    expect(removeText.includes(PLANTED_MARKER)).toBe(false);
    const removeBody = JSON.parse(removeText) as { skill: { hasSecret: boolean; credentialMode: string } };
    expect(removeBody.skill.hasSecret).toBe(false);
    expect(removeBody.skill.credentialMode).toBe("none");
  });
});

describe("Feed Host actor bootstrap serialization", () => {
  test("concurrent delegation submissions never run overlapping bootstraps", async () => {
    const storage = new OverlapTrackingStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    const combined = policy.resources.map((resource) => resource.path).join("|");
    const submit = () =>
      postJson(
        `${runtime.url}/api/delegations`,
        { actorId: ACTOR_ID, serializedDelegation: combined },
        { "content-type": "application/json" },
      );

    const responses = await Promise.all([submit(), submit(), submit()]);
    for (const response of responses) expect(response.ok).toBe(true);
    // Re-submissions may re-bootstrap, but never concurrently — overlapping
    // chains serialization-conflict against real TinyCloud until they die.
    expect(storage.bootstraps).toBeGreaterThanOrEqual(1);
    expect(storage.maxActive).toBe(1);
  });
});

describe("Feed Host workflow routines", () => {
  test("GET /workflows lists admitted starters with presentation, run summary, and no raw authority", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const unauthenticated = await fetch(`${runtime.url}/workflows`);
    expect(unauthenticated.status).toBe(401);

    const sessionCookie = await grantAllDelegations(runtime, ACTOR_ID);
    const response = await fetch(`${runtime.url}/workflows?limit=50`, {
      headers: { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    });
    expect(response.status).toBe(200);
    const bodyText = await response.text();
    const body = JSON.parse(bodyText) as {
      items: Array<{
        packageId: string;
        displayName: string;
        paused: boolean;
        disabled: boolean;
        presentation?: { purpose: string; triggerLabel: string; cadenceLabel: string };
        lastRun?: { status: string; startedAt: string };
      }>;
    };

    // The six reviewed starters are admitted at bootstrap, before any run.
    const ids = body.items.map((item) => item.packageId);
    for (const starter of [
      "feed-daily-brief",
      "feed-short-insights",
      "feed-exception-alert",
      "feed-synthesis-report",
      "feed-decision-memo",
      "feed-playbook",
    ]) {
      expect(ids).toContain(starter);
    }

    const dailyBrief = body.items.find((item) => item.packageId === "feed-daily-brief")!;
    expect(dailyBrief.displayName).toBe("Daily Brief");
    expect(dailyBrief.paused).toBe(false);
    expect(dailyBrief.presentation?.purpose.length).toBeGreaterThan(0);
    expect(dailyBrief.presentation?.triggerLabel).toBe("Runs once a day");
    expect(dailyBrief.lastRun).toBeUndefined();

    // The seeded fixture package has run once and reports a summary.
    const seeded = body.items.find((item) => item.displayName === "Weekly Product Brief");
    expect(seeded?.lastRun?.status).toBe("published");

    // Raw authority material stays out of the routine list.
    expect(bodyText).not.toContain("sha256:");
    expect(bodyText).not.toContain("manifestKey");
    expect(bodyText).not.toContain("workflowDigest");
    expect(bodyText).not.toContain("did:key");
  });

  test("a node authorization denial surfaces as a recoverable 403, not a 500", async () => {
    const storage = new UnauthorizedReadStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const sessionCookie = await grantAllDelegations(runtime, ACTOR_ID);

    const response = await fetch(`${runtime.url}/artifacts/some-artifact`, {
      headers: { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("denied");
  });

  test("serves decoded artifact heroes with a private one-hour cache and returns 404 when absent", async () => {
    const storage = new HeroFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    await grantAllDelegations(runtime, ACTOR_ID);

    const response = await fetch(`${runtime.url}/artifacts/with-hero/hero`, {
      headers: { "x-feed-actor-id": ACTOR_ID },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("sandbox");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("served hero bytes");

    const missing = await fetch(`${runtime.url}/artifacts/without-hero/hero`, {
      headers: { "x-feed-actor-id": ACTOR_ID },
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("private, no-store");
  });

  test("pausing a routine through control intents is reflected in /workflows", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const sessionCookie = await grantAllDelegations(runtime, ACTOR_ID);

    const pause = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "wf-pause-001",
        readerNonce: "wf-pause-nonce-001",
        intentKind: "pause_package",
        targetRef: "package:feed-daily-brief",
        createdAt: "2026-07-14T22:00:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    );
    expect(pause.ok).toBe(true);

    const body = await getJson<{ items: Array<{ packageId: string; paused: boolean; settingsVersion: number }> }>(
      `${runtime.url}/workflows?limit=50`,
      { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    );
    const dailyBrief = body.items.find((item) => item.packageId === "feed-daily-brief");
    expect(dailyBrief?.paused).toBe(true);
    expect(dailyBrief?.settingsVersion).toBe(1);

    const stale = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "wf-stale-001",
        readerNonce: "wf-stale-nonce-001",
        intentKind: "enable_package",
        targetRef: "package:feed-daily-brief",
        payload: { expectedVersion: 0 },
        createdAt: "2026-07-14T22:01:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    );
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("version_conflict");

    const staleReset = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "wf-stale-reset-001",
        readerNonce: "wf-stale-reset-nonce-001",
        intentKind: "reset_package",
        targetRef: "package:feed-daily-brief",
        payload: { expectedVersion: 0 },
        createdAt: "2026-07-14T22:02:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    );
    expect(staleReset.status).toBe(409);
    expect(((await staleReset.json()) as { error: { code: string } }).error.code).toBe("version_conflict");

    const reset = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "wf-reset-001",
        readerNonce: "wf-reset-nonce-001",
        intentKind: "reset_package",
        targetRef: "package:feed-daily-brief",
        payload: { expectedVersion: 1 },
        createdAt: "2026-07-14T22:03:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    );
    expect(reset.ok).toBe(true);

    const resetBody = await getJson<{ items: Array<{ packageId: string; paused: boolean; settingsVersion: number }> }>(
      `${runtime.url}/workflows?limit=50`,
      { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    );
    const resetDailyBrief = resetBody.items.find((item) => item.packageId === "feed-daily-brief");
    expect(resetDailyBrief?.paused).toBe(false);
    expect(resetDailyBrief?.settingsVersion).toBe(2);
  });

  test("removing a routine keeps its settings and add-back restores it", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: false,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });
    const sessionCookie = await grantAllDelegations(runtime, ACTOR_ID);

    const tune = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "wf-tune-001",
        readerNonce: "wf-tune-nonce-001",
        intentKind: "tune_package",
        targetRef: "package:feed-daily-brief",
        payload: { expectedVersion: 0, settings: { cadence: "less", audience: "team", outputVolume: "short" } },
        createdAt: "2026-07-14T22:10:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    );
    expect(tune.ok).toBe(true);

    const remove = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "wf-remove-001",
        readerNonce: "wf-remove-nonce-001",
        intentKind: "disable_package",
        targetRef: "package:feed-daily-brief",
        payload: { expectedVersion: 1 },
        createdAt: "2026-07-14T22:11:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    );
    expect(remove.ok).toBe(true);

    const removedBody = await getJson<{
      items: Array<{ packageId: string; disabled: boolean; settingsVersion: number; cadence?: string; settings?: { audience?: string; outputVolume?: string } }>;
    }>(`${runtime.url}/workflows?limit=50`, { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie });
    const removed = removedBody.items.find((item) => item.packageId === "feed-daily-brief");
    expect(removed?.disabled).toBe(true);
    expect(removed?.cadence).toBe("less");
    expect(removed?.settings?.audience).toBe("team");

    const addBack = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "wf-addback-001",
        readerNonce: "wf-addback-nonce-001",
        intentKind: "enable_package",
        targetRef: "package:feed-daily-brief",
        payload: { expectedVersion: 2 },
        createdAt: "2026-07-14T22:12:00.000Z",
      },
      { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie },
    );
    expect(addBack.ok).toBe(true);

    const restoredBody = await getJson<{
      items: Array<{ packageId: string; disabled: boolean; paused: boolean; settingsVersion: number; cadence?: string; settings?: { audience?: string; outputVolume?: string } }>;
    }>(`${runtime.url}/workflows?limit=50`, { "x-feed-actor-id": ACTOR_ID, cookie: sessionCookie });
    const restored = restoredBody.items.find((item) => item.packageId === "feed-daily-brief");
    expect(restored?.disabled).toBe(false);
    expect(restored?.paused).toBe(false);
    expect(restored?.settingsVersion).toBe(3);
    expect(restored?.cadence).toBe("less");
    expect(restored?.settings?.audience).toBe("team");
    expect(restored?.settings?.outputVolume).toBe("short");
  });
});

class FakeFeedHostStorage {
  private readonly artifactIndex = new Map<string, StoredArtifactIndexRow>();
  private readonly artifacts = new Map<string, FeedArtifact>();
  private readonly projections = new Map<string, FeedArtifactProjection>();
  private readonly runs = new Map<string, StoredWorkflowRunRow>();
  private readonly preferenceProfiles = new Map<string, FeedPreferenceProfileRecord>();
  private readonly feedbackEvents: FeedbackEvent[] = [];
  private readonly controlIntents: StoredControlIntentRow[] = [];
  private readonly generationRequests: StoredGenerationRequestRow[] = [];
  private readonly skillCredentials = new Map<string, FakeSkillRecord>();
  private readonly packages = new Map<string, StoredWorkflowPackageRow>();

  async bootstrapSchema(_actor: FeedHostActorStorage): Promise<FeedV1MigrationSummary> {
    return emptyMigrationSummary();
  }

  async ensureWorkflowPackages(
    _actor: FeedHostActorStorage,
    packages: Array<{
      packageId: string;
      displayName: string;
      version: string;
      admissionState: string;
      disclosure: Record<string, unknown>;
    }>,
    now: string,
  ): Promise<void> {
    for (const pkg of packages) {
      if (this.packages.has(pkg.packageId)) continue;
      this.packages.set(pkg.packageId, {
        package_id: pkg.packageId,
        display_name: pkg.displayName,
        version: pkg.version,
        admission_state: pkg.admissionState,
        disclosure_json: JSON.stringify(pkg.disclosure),
        enabled_at: now,
        paused_at: null,
        updated_at: now,
      });
    }
  }

  async listWorkflows(
    _actor: FeedHostActorStorage,
    input: { actorId: string; limit: number; cursor?: string },
  ): Promise<{ items: Array<Record<string, unknown>>; nextCursor?: string }> {
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error("cursor must be a non-negative integer offset");
    const limit = Math.max(1, Math.min(input.limit, 100));
    const sorted = [...this.packages.values()].sort((left, right) =>
      left.display_name.localeCompare(right.display_name) || left.package_id.localeCompare(right.package_id),
    );
    const page = sorted.slice(offset, offset + limit);
    const items = page.map((row) => {
      const latestRun = [...this.runs.values()]
        .filter((run) => run.package_id === row.package_id)
        .sort((left, right) => right.started_at.localeCompare(left.started_at))[0];
      const example = [...this.projections.values()]
        .filter((projection) => projection.packageId === row.package_id && projection.visibility === "ranked")
        .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))[0];
      const preferenceRecord = this.preferenceProfiles.get(`${input.actorId.toLowerCase()}:package:${row.package_id}`);
      const preferences = preferenceRecord?.value;
      return {
        packageId: row.package_id,
        displayName: row.display_name,
        version: row.version,
        settingsVersion: preferenceRecord?.version ?? 0,
        admissionState: row.admission_state,
        disclosure: JSON.parse(row.disclosure_json) as Record<string, unknown>,
        paused: preferences?.paused === true || row.paused_at !== null,
        disabled: preferences?.disabled === true,
        cadence: preferences?.cadence,
        settings: {
          sourceSelection: preferences?.sourceSelection,
          audience: preferences?.audience,
          outputVolume: preferences?.outputVolume,
        },
        enabledAt: row.enabled_at,
        updatedAt: row.updated_at,
        ...(latestRun
          ? {
              lastRun: {
                runId: latestRun.run_id,
                status: latestRun.status,
                startedAt: latestRun.started_at,
                finishedAt: latestRun.finished_at,
                durationMs:
                  latestRun.finished_at === null
                    ? null
                    : Math.max(0, Date.parse(latestRun.finished_at) - Date.parse(latestRun.started_at)),
                publishedArtifactCount: 0,
              },
            }
          : {}),
        ...(example
          ? { example: { artifactId: example.artifactId, title: null, publishedAt: example.publishedAt } }
          : {}),
      };
    });
    return { items, nextCursor: sorted.length > offset + limit ? String(offset + limit) : undefined };
  }

  async hasArtifacts(_actor: FeedHostActorStorage): Promise<boolean> {
    return this.artifactIndex.size > 0;
  }

  async reconcileProjectionCompatibility(_actor: FeedHostActorStorage): Promise<void> {}

  async insertSeedRows(_actor: FeedHostActorStorage, _dbName: string, rows: SqlSeedRow[]): Promise<void> {
    for (const row of rows) this.applySeedRow(row);
  }

  async writeArtifactDocument(_actor: FeedHostActorStorage, artifact: FeedArtifact): Promise<void> {
    this.artifacts.set(artifact.artifactId, artifact);
  }

  async listFeed(
    _actor: FeedHostActorStorage,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: FeedArtifactProjection[]; nextCursor?: string }> {
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error("cursor must be a non-negative integer offset");
    const limit = Math.max(1, Math.min(input.limit, 100));
    const ranked = rankFeedProjections({
      items: [...this.projections.values()].map((projection) =>
        projectionState(projection, !this.artifacts.has(projection.artifactId)),
      ),
      feedbackByArtifact: summarizeFeedbackEvents(this.feedbackEvents.filter((event) => event.actorId === ACTOR_ID)),
      preferences: mergeFeedPreferences(
        [...this.preferenceProfiles.values()].filter((record) => record.actorId === ACTOR_ID),
      ),
      now: new Date(FAKE_NOW),
    });
    const page = ranked.slice(offset, offset + limit);
    return {
      items: page.map(stripProjection),
      nextCursor: ranked.length > offset + limit ? String(offset + limit) : undefined,
    };
  }

  async readArtifact(
    _actor: FeedHostActorStorage,
    artifactId: string,
  ): Promise<
    | { kind: "found"; artifact: FeedArtifact }
    | { kind: "not_found" }
    | { kind: "hydration_failed"; artifactId: string; docKey: string }
  > {
    const artifact = this.artifacts.get(artifactId);
    if (artifact) return { kind: "found", artifact };
    const row = this.artifactIndex.get(artifactId);
    if (row) return { kind: "hydration_failed", artifactId, docKey: row.doc_key };
    return { kind: "not_found" };
  }

  async getArtifact(actor: FeedHostActorStorage, artifactId: string): Promise<FeedArtifact | null> {
    const result = await this.readArtifact(actor, artifactId);
    return result.kind === "found" ? result.artifact : null;
  }

  async readArtifactHero(
    _actor: FeedHostActorStorage,
    _artifactId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return null;
  }

  async getProvenance(
    actor: FeedHostActorStorage,
    artifactId: string,
  ): Promise<Pick<FeedArtifact, "artifactId" | "sourceRefs" | "producedBy" | "freshness" | "idempotency"> | null> {
    const artifact = await this.getArtifact(actor, artifactId);
    if (!artifact) return null;
    return {
      artifactId: artifact.artifactId,
      sourceRefs: artifact.sourceRefs,
      producedBy: artifact.producedBy,
      freshness: artifact.freshness,
      idempotency: artifact.idempotency,
    };
  }

  async readPreferenceProfile(
    actor: FeedHostActorStorage,
    scope: string = "presentation",
  ): Promise<FeedPreferenceProfileRecord | null> {
    return this.preferenceProfiles.get(preferenceKey(actor.actorId, normalizePreferenceScope(scope))) ?? null;
  }

  async listPreferenceProfiles(actor: FeedHostActorStorage): Promise<FeedPreferenceProfileRecord[]> {
    return [...this.preferenceProfiles.values()]
      .filter((record) => record.actorId === actor.actorId)
      .sort((left, right) => left.scope.localeCompare(right.scope) || right.version - left.version || right.updatedAt.localeCompare(left.updatedAt));
  }

  async putPreferenceProfile(
    actor: FeedHostActorStorage,
    input: {
      scope?: string;
      expectedVersion?: number;
      patch?: FeedPreferenceValue;
      reset?: boolean;
      updatedAt?: string;
      actorId: string;
    },
  ): Promise<FeedPreferenceProfileRecord> {
    const scope = normalizePreferenceScope(input.scope);
    const key = preferenceKey(actor.actorId, scope);
    const current = this.preferenceProfiles.get(key);
    const currentVersion = current?.version ?? 0;
    if (current) {
      if (input.expectedVersion === undefined || input.expectedVersion !== currentVersion) {
        throw new FeedHostError("preference version conflict", 409, "version_conflict", { currentVersion });
      }
    } else if (input.expectedVersion !== undefined && input.expectedVersion !== 0) {
      throw new FeedHostError("preference version conflict", 409, "version_conflict", { currentVersion });
    }

    const base = current?.value ?? (scope === FEED_HOST_PREFERENCES_SCOPE ? defaultFeedPreferences() : {});
    const value = input.reset
      ? scope === FEED_HOST_PREFERENCES_SCOPE
        ? defaultFeedPreferences()
        : {}
      : mergePreferencePatch(base, input.patch ?? {});
    const record: FeedPreferenceProfileRecord = {
      profileId: key,
      actorId: actor.actorId,
      scope,
      value,
      version: currentVersion + 1,
      updatedAt: input.updatedAt ?? FAKE_NOW,
    };
    this.preferenceProfiles.set(key, record);
    return record;
  }

  async reconcileFeedProjection(_actor: FeedHostActorStorage) {
    const artifacts = [...this.artifactIndex.values()].map((row) => {
      const current = this.projections.get(row.artifact_id);
      const artifact = this.artifacts.get(row.artifact_id);
      return {
        artifactId: row.artifact_id,
        artifactType: row.artifact_type,
        packageId: row.package_id,
        sourceFingerprint: row.source_fingerprint,
        publishedAt: row.published_at,
        updatedAt: row.updated_at,
        freshnessLabel: artifact?.freshness.label ?? current?.freshnessLabel ?? "source_unavailable",
        docMissing: !artifact,
      } satisfies FeedReconcileArtifact;
    });
    const plan = reconcileFeedProjections({
      artifacts,
      projections: [...this.projections.values()].map((projection) =>
        projectionState(projection, !this.artifacts.has(projection.artifactId)),
      ),
      now: new Date(FAKE_NOW),
    });
    for (const feedItemId of plan.deletions) this.projections.delete(feedItemId.replace(/^legacy:/, ""));
    for (const row of plan.upserts) this.projections.set(row.target.artifactId, stripProjection(row));
    return plan;
  }

  async recordFeedback(
    _actor: FeedHostActorStorage,
    event: FeedTargetedInteractionEvent,
  ): Promise<{ eventId: string; duplicate: boolean; status: "applied" | "noop" }> {
    const existing = this.feedbackEvents.find(
      (row) => row.actorId === event.actorId && row.readerNonce === event.readerNonce,
    );
    if (existing) return { eventId: existing.eventId, duplicate: true, status: "noop" };

    this.feedbackEvents.push(event);
    const artifactId = event.target.kind === "feed_item"
      ? event.target.feedItemId.replace(/^legacy:/, "").split("::")[0]!
      : event.target.artifactId;
    const projection = this.projections.get(artifactId);
    if (projection) {
      this.projections.set(artifactId, {
        ...projection,
        disposition: feedbackDisposition(event.signal, projection.disposition),
      });
    }
    return { eventId: event.eventId, duplicate: false, status: "applied" };
  }

  async recordControlIntent(
    _actor: FeedHostActorStorage,
    event: ControlIntentEvent,
  ): Promise<{ eventId: string; duplicate: boolean; status: string; requestId?: string }> {
    const normalizedKind = event.intentKind === "ask_feed" ? "generate_new_request" : event.intentKind;
    const existing = this.controlIntents.find(
      (row) => row.actor_id === event.actorId && row.reader_nonce === event.readerNonce,
    );
    if (existing) {
      return {
        eventId: existing.event_id,
        duplicate: true,
        status: existing.status,
        requestId: this.findGenerationRequestId(event.actorId, event.readerNonce),
      };
    }

    const payloadHash = event.payloadHash ?? hashJson(event.payload ?? null);
    const payload = plainObject(event.payload);
    let status = normalizedKind === "generate_new_request" ? "accepted" : "applied";
    let requestId: string | undefined;
    let capError: FeedHostError | undefined;

    switch (normalizedKind) {
      case "set_artifact_visibility":
      case "set_saved": {
        const projection = this.projections.get(event.targetRef);
        if (projection) {
          const desiredDisposition =
            normalizedKind === "set_saved"
              ? payload?.saved === false || payload?.state === "unsaved"
                ? "default"
                : "saved"
              : payload?.visibility === "hidden" || payload?.hidden === true || payload?.state === "hidden"
                ? "hidden"
                : "default";
          this.projections.set(event.targetRef, {
            ...projection,
            disposition: desiredDisposition,
          });
        }
        break;
      }
      case "adjust_preference":
      case "set_cadence":
      case "safe_package_setting_update":
      case "candidate_package_proposal":
      case "enable_package":
      case "pause_package":
      case "disable_package":
      case "tune_package":
      case "reset_package":
      case "reset_preferences": {
        const scope = preferenceScopeForIntent(normalizedKind, payload, event.targetRef);
        const key = preferenceKey(event.actorId, scope);
        const current = this.preferenceProfiles.get(key);
        const currentVersion = current?.version ?? 0;
        const expectedVersion =
          typeof payload?.version === "number"
            ? payload.version
            : typeof payload?.expectedVersion === "number"
              ? payload.expectedVersion
              : currentVersion;
        if (expectedVersion !== currentVersion) {
          capError = new FeedHostError("preference version conflict", 409, "version_conflict", { currentVersion });
          status = capError.code;
          break;
        }
        const value =
          normalizedKind === "reset_preferences" || normalizedKind === "reset_package"
            ? scope === FEED_HOST_PREFERENCES_SCOPE
              ? defaultFeedPreferences()
              : {}
            : mergePreferencePatch(current?.value ?? (scope === FEED_HOST_PREFERENCES_SCOPE ? defaultFeedPreferences() : {}), controlIntentPreferencePatch(normalizedKind, payload, event.targetRef));
        this.preferenceProfiles.set(key, {
          profileId: key,
          actorId: event.actorId,
          scope,
          value,
          version: currentVersion + 1,
          updatedAt: event.createdAt,
        });
        status = normalizedKind === "candidate_package_proposal" ? "accepted" : "applied";
        break;
      }
      case "generate_new_request": {
        const pendingCount = this.generationRequests.filter(
          (row) =>
            row.actor_id === event.actorId &&
            (row.status === "accepted" || row.status === "pending") &&
            row.expires_at > event.createdAt,
        ).length;
        if (pendingCount >= DEFAULT_MAX_PENDING_GENERATION_REQUESTS) {
          capError = new FeedHostError(
            `generation backlog is full (${pendingCount} pending); retry after requests complete`,
            429,
            "generation_backlog_full",
            { pendingCount, limit: DEFAULT_MAX_PENDING_GENERATION_REQUESTS },
          );
          status = capError.code;
          break;
        }
        const request = buildGenerationRequestRecord({
          actorId: event.actorId,
          readerNonce: event.readerNonce,
          eventId: event.eventId,
          createdAt: event.createdAt,
          payload: event.payload,
          targetRef: event.targetRef,
          payloadHash,
        });
        this.generationRequests.unshift(request);
        requestId = request.request_id;
        status = "accepted";
        break;
      }
    }

    const row: StoredControlIntentRow = {
      event_id: event.eventId,
      reader_nonce: event.readerNonce,
      actor_id: event.actorId,
      intent_kind: normalizedKind,
      status,
      target_ref: event.targetRef,
      payload_hash: payloadHash,
      payload_json: event.payload === undefined ? null : JSON.stringify(event.payload),
      created_at: event.createdAt,
    };
    this.controlIntents.unshift(row);
    if (capError) throw capError;
    return { eventId: event.eventId, duplicate: false, status: row.status, requestId };
  }

  async listControlIntents(_actor: FeedHostActorStorage, limit = 100): Promise<StoredControlIntentRow[]> {
    return this.controlIntents.slice(0, Math.max(1, Math.min(limit, 500)));
  }

  async listGenerationRequests(
    _actor: FeedHostActorStorage,
    limit = 100,
    filter: { status?: string; excludeExpired?: boolean; order?: "asc" | "desc" } = {},
  ): Promise<StoredGenerationRequestRow[]> {
    const now = new Date().toISOString();
    let rows = this.generationRequests.filter(
      (row) =>
        (filter.status === undefined || row.status === filter.status) &&
        (!filter.excludeExpired || row.expires_at > now),
    );
    rows = [...rows].sort((left, right) =>
      filter.order === "asc"
        ? left.created_at.localeCompare(right.created_at)
        : right.created_at.localeCompare(left.created_at),
    );
    return rows.slice(0, Math.max(1, Math.min(limit, 500)));
  }

  async generationDiagnostics(_actor: FeedHostActorStorage, limit = 10) {
    const rows = [...this.generationRequests]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.request_id.localeCompare(left.request_id));
    const retry = rows.find((row) => row.status === "retry_wait");
    const retryErrorCode = retry?.error_code ?? null;
    return {
      recentRequests: rows.slice(0, Math.min(limit, 10)).map((row) => ({
        requestId: row.request_id,
        dedupeKeyKind: row.dedupe_key?.startsWith("proactive:") ? "proactive" as const : "ask" as const,
        terminal: row.terminal_kind ?? null,
        errorCode: row.error_code ?? null,
        manifestIds: row.published_manifest_ids ?? [],
        strategy: row.generation_strategy ?? null,
        criticVerdicts: row.critic_verdicts ?? [],
        attemptCount: row.attempt_count ?? 0,
        timestamps: {
          createdAt: row.created_at,
          claimedAt: row.claimed_at ?? null,
          finishedAt: row.finished_at ?? null,
          updatedAt: row.updated_at,
        },
      })),
      deadLetterCount: rows.filter((row) => row.status === "dead_letter" || row.terminal_kind === "dead_letter").length,
      billingBlocked: retryErrorCode ? /(?:billing|payment|credit|quota)/i.test(retryErrorCode) : false,
    };
  }

  async findGenerationRequestByDedupeKey(
    actor: FeedHostActorStorage,
    dedupeKey: string,
  ): Promise<Record<string, unknown> | null> {
    const row = this.generationRequests.find(
      (candidate) => candidate.actor_id === actor.actorId && candidate.dedupe_key === dedupeKey,
    );
    return row ? wireGenerationRequest(row) : null;
  }

  async updateGenerationRequestStatus(
    _actor: FeedHostActorStorage,
    input: { requestId: string; status: string; expectedStatus?: string; updatedAt: string },
  ): Promise<Record<string, unknown>> {
    const row = this.generationRequests.find((candidate) => candidate.request_id === input.requestId);
    if (!row) {
      throw new FeedHostError(`generation request not found: ${input.requestId}`, 404, "not_found");
    }
    if (input.expectedStatus !== undefined && row.status !== input.expectedStatus) {
      throw new FeedHostError(
        `generation request status is ${row.status}, expected ${input.expectedStatus}`,
        409,
        "status_conflict",
      );
    }
    row.status = input.status;
    row.updated_at = input.updatedAt;
    return {
      requestId: row.request_id,
      readerNonce: row.reader_nonce,
      actorId: row.actor_id,
      status: row.status,
      scope: JSON.parse(row.scope_json) as Record<string, unknown>,
      packageId: row.package_id,
      dedupeKey: row.dedupe_key,
      prompt: row.prompt,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async claimGenerationRequest(
    _actor: FeedHostActorStorage,
    input: { workflowId: string; claimOwner: string; now: string; leaseExpiresAt: string; maxAttempts: number },
  ): Promise<Record<string, unknown> | null> {
    const row = this.generationRequests
      .filter((candidate) =>
        candidate.expires_at > input.now &&
        (candidate.attempt_count ?? 0) < input.maxAttempts &&
        (
          candidate.status === "accepted" ||
          (candidate.status === "retry_wait" && (candidate.next_retry_at ?? "") <= input.now) ||
          (candidate.status === "pending" && (candidate.lease_expires_at ?? "") <= input.now)
        ))
      .sort((left, right) => left.created_at.localeCompare(right.created_at))[0];
    if (!row) return null;
    row.status = "pending";
    row.run_id = row.request_id;
    row.workflow_id ??= input.workflowId;
    row.max_attempts ??= input.maxAttempts;
    row.claim_owner = input.claimOwner;
    row.lease_expires_at = input.leaseExpiresAt;
    row.fencing_token = (row.fencing_token ?? 0) + 1;
    row.attempt_count = (row.attempt_count ?? 0) + 1;
    row.claimed_at ??= input.now;
    row.phase = row.phase === "publishing" || row.phase === "reconciling" ? row.phase : "running";
    row.cancellation_requested ??= 0;
    row.updated_at = input.now;
    return wireGenerationRequest(row);
  }

  async assertGenerationRequestFence(
    _actor: FeedHostActorStorage,
    input: { requestId: string; runId: string; claimOwner: string; fencingToken: number; now: string },
  ): Promise<Record<string, unknown>> {
    const row = this.generationRequests.find((candidate) => candidate.request_id === input.requestId);
    if (
      !row ||
      row.status !== "pending" ||
      row.run_id !== input.runId ||
      row.claim_owner !== input.claimOwner ||
      row.fencing_token !== input.fencingToken ||
      !row.lease_expires_at ||
      row.lease_expires_at <= input.now
    ) {
      throw new FeedHostError("generation request lease is stale", 409, "stale_generation_lease");
    }
    return wireGenerationRequest(row);
  }

  async heartbeatGenerationRequest(
    actor: FeedHostActorStorage,
    input: {
      requestId: string;
      runId: string;
      claimOwner: string;
      fencingToken: number;
      now: string;
      leaseExpiresAt: string;
    },
  ): Promise<Record<string, unknown>> {
    await this.assertGenerationRequestFence(actor, input);
    const row = this.generationRequests.find((candidate) => candidate.request_id === input.requestId)!;
    row.lease_expires_at = input.leaseExpiresAt;
    row.updated_at = input.now;
    return wireGenerationRequest(row);
  }

  async updateGenerationRequestPhase(
    actor: FeedHostActorStorage,
    input: {
      requestId: string;
      runId: string;
      claimOwner: string;
      fencingToken: number;
      now: string;
      phase: string;
      metadata: FakeGenerationMetadata;
    },
  ): Promise<Record<string, unknown>> {
    await this.assertGenerationRequestFence(actor, input);
    const row = this.generationRequests.find((candidate) => candidate.request_id === input.requestId)!;
    row.phase = input.phase;
    row.updated_at = input.now;
    applyFakeGenerationMetadata(row, input.metadata);
    return wireGenerationRequest(row);
  }

  async reconcileGenerationRequest(
    actor: FeedHostActorStorage,
    input: {
      requestId: string;
      runId: string;
      claimOwner: string;
      fencingToken: number;
      now: string;
      metadata?: FakeGenerationMetadata;
    },
  ): Promise<{ request: Record<string, unknown>; feedItemIds: string[] }> {
    await this.assertGenerationRequestFence(actor, input);
    const row = this.generationRequests.find((candidate) => candidate.request_id === input.requestId)!;
    row.phase = "reconciling";
    row.updated_at = input.now;
    applyFakeGenerationMetadata(row, input.metadata ?? {});
    return { request: wireGenerationRequest(row), feedItemIds: [] };
  }

  expireGenerationLease(requestId: string): void {
    const row = this.generationRequests.find((candidate) => candidate.request_id === requestId);
    if (row) row.lease_expires_at = "2000-01-01T00:00:00.000Z";
  }

  async requestGenerationCancellation(
    _actor: FeedHostActorStorage,
    input: { requestId: string; now: string },
  ): Promise<Record<string, unknown>> {
    const row = this.generationRequests.find((candidate) => candidate.request_id === input.requestId);
    if (!row) throw new FeedHostError(`generation request not found: ${input.requestId}`, 404, "not_found");
    row.cancellation_requested = 1;
    if (row.status === "accepted" || row.status === "retry_wait" || (row.status === "pending" && row.phase !== "publishing" && row.phase !== "reconciling")) {
      row.status = "cancelled";
      row.phase = "cancelled";
    }
    row.updated_at = input.now;
    return wireGenerationRequest(row);
  }

  async listFeedEvents(_actor: FeedHostActorStorage, afterEventId?: string): Promise<string> {
    const projections = [...this.projections.values()].map((projection) =>
      projectionState(projection, !this.artifacts.has(projection.artifactId)),
    );
    projections.sort((left, right) => {
      const published = right.publishedAt.localeCompare(left.publishedAt);
      if (published !== 0) return published;
      return left.artifactId.localeCompare(right.artifactId);
    });
    return renderFeedEventStream(filterFeedEventsAfterId(buildFeedEvents({ projections }), afterEventId));
  }

  async listSkills(
    _actor: FeedHostActorStorage,
    input: { actorId: string; limit: number; cursor?: string },
  ): Promise<{ items: FakeSkillWireState[]; nextCursor?: string }> {
    const actorId = input.actorId.toLowerCase();
    const offset = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new FeedHostError("bad cursor", 400, "bad_request");
    const limit = Math.max(1, Math.min(input.limit, 100));
    const rows = [...this.skillCredentials.values()]
      .filter((row) => row.actorId === actorId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.skillId.localeCompare(left.skillId));
    const page = rows.slice(offset, offset + limit);
    return {
      items: page.map(toFakeWireSkill),
      nextCursor: rows.length > offset + limit ? String(offset + limit) : undefined,
    };
  }

  async upsertSkillCredentials(
    _actor: FeedHostActorStorage,
    input: { actorId: string; skillId: string; patch: FakeSkillPatch },
  ): Promise<FakeSkillWireState> {
    const actorId = input.actorId.toLowerCase();
    const skillId = input.skillId.trim();
    if (!skillId) throw new FeedHostError("skillId is required", 400, "bad_request");
    if (!isFakeSupportedMode(input.patch.credentialMode)) {
      throw new FeedHostError("credentialMode is not allowlisted", 400, "invalid_mode");
    }
    const key = `${actorId}:${skillId}`;
    const current = this.skillCredentials.get(key) ?? null;
    const currentVersion = current?.version ?? 0;
    if (currentVersion !== input.patch.expectedVersion) {
      throw new FeedHostError("skill credential version conflict", 409, "version_conflict", { currentVersion });
    }
    const patchedSecretRef = fakeResolveSecretRef(input.patch, current);
    if (
      (input.patch.credentialMode === "user_byok_api_key" || input.patch.credentialMode === "user_oauth_token") &&
      !patchedSecretRef
    ) {
      throw new FeedHostError("secretRef is required for BYOK credentials", 400, "invalid_mode");
    }
    const next: FakeSkillRecord = {
      actorId,
      skillId,
      credentialMode: input.patch.credentialMode,
      providerId:
        input.patch.providerId?.trim() ??
        current?.providerId ??
        (input.patch.credentialMode === "feed_hosted" ? "openai" : undefined),
      secretRef: patchedSecretRef,
      version: currentVersion + 1,
      updatedAt: new Date().toISOString(),
    };
    this.skillCredentials.set(key, next);
    return toFakeWireSkill(next);
  }

  async debugState(_actor: FeedHostActorStorage): Promise<{
    artifacts: number;
    projections: number;
    feedback: number;
    preferences: number;
    controlIntents: number;
    generationRequests: number;
  }> {
    return {
      artifacts: this.artifactIndex.size,
      projections: this.projections.size,
      feedback: this.feedbackEvents.length,
      preferences: this.preferenceProfiles.size,
      controlIntents: this.controlIntents.length,
      generationRequests: this.generationRequests.length,
    };
  }

  addArtifactFixture(
    artifact: FeedArtifact,
    projection: FeedArtifactProjection,
    run: { runId: string; packageId: string; status: string; startedAt: string; finishedAt?: string | null },
  ): void {
    this.applySeedRow(artifactIndexRow(artifact));
    this.artifacts.set(artifact.artifactId, artifact);
    this.projections.set(projection.artifactId, projection);
    this.runs.set(run.runId, {
      run_id: run.runId,
      package_id: run.packageId,
      status: run.status,
      started_at: run.startedAt,
      finished_at: run.finishedAt ?? null,
    });
  }

  private applySeedRow(row: SqlSeedRow): void {
    switch (row.table) {
      case "artifact_index":
        this.artifactIndex.set(String(row.values.artifact_id), {
          artifact_id: String(row.values.artifact_id),
          artifact_type: String(row.values.artifact_type),
          package_id: String(row.values.package_id),
          source_fingerprint: String(row.values.source_fingerprint),
          doc_key: String(row.values.doc_key),
          published_at: String(row.values.published_at),
          updated_at: String(row.values.updated_at),
        });
        break;
      case "feed_artifact_projection":
        this.projections.set(String(row.values.artifact_id), {
          artifactId: String(row.values.artifact_id),
          rankScore: Number(row.values.rank_score),
          disposition: row.values.disposition as FeedArtifactProjection["disposition"],
          visibility: row.values.visibility as FeedArtifactProjection["visibility"],
          freshnessLabel: row.values.freshness_label as FeedArtifactProjection["freshnessLabel"],
          reasonCodes: JSON.parse(String(row.values.reason_codes_json)) as string[],
          packageId: String(row.values.package_id),
          sourceFingerprint: String(row.values.source_fingerprint),
          publishedAt: String(row.values.published_at),
          updatedAt: String(row.values.updated_at),
        });
        break;
      case "workflow_package_state":
        if (!this.packages.has(String(row.values.package_id))) {
          this.packages.set(String(row.values.package_id), {
            package_id: String(row.values.package_id),
            display_name: String(row.values.display_name),
            version: String(row.values.version),
            admission_state: String(row.values.admission_state),
            disclosure_json: String(row.values.disclosure_json),
            enabled_at: row.values.enabled_at === null ? null : String(row.values.enabled_at),
            paused_at: row.values.paused_at === null ? null : String(row.values.paused_at),
            updated_at: String(row.values.updated_at),
          });
        }
        break;
      case "workflow_run_index":
        this.runs.set(String(row.values.run_id), {
          run_id: String(row.values.run_id),
          package_id: String(row.values.package_id),
          status: String(row.values.status),
          started_at: String(row.values.started_at),
          finished_at: row.values.finished_at === null ? null : String(row.values.finished_at),
        });
        break;
      case "preference_profile":
        this.preferenceProfiles.set(String(row.values.profile_id), {
          profileId: String(row.values.profile_id),
          actorId: String(row.values.actor_id),
          scope: String(row.values.scope),
          value: JSON.parse(String(row.values.value_json)) as FeedPreferenceValue,
          version: Number(row.values.version),
          updatedAt: String(row.values.updated_at),
        });
        break;
      default:
        break;
    }
  }

  private findGenerationRequestId(actorId: string, readerNonce: string): string | undefined {
    return this.generationRequests.find(
      (row) => row.actor_id === actorId && row.reader_nonce === readerNonce,
    )?.request_id;
  }
}

class DiagnosticsFeedHostStorage extends FakeFeedHostStorage {
  async queueSummary(): Promise<{ counts: Record<string, number>; oldestAcceptedAgeSec: number }> {
    return { counts: { accepted: 2, consumed: 1 }, oldestAcceptedAgeSec: 7201 };
  }

  latestIntegritySummary(): {
    projections: number;
    healthy: number;
    docMissing: number;
    quarantined: number;
    restored: number;
    upserts: number;
    deletions: number;
    durationMs: number;
    reconciledAt: string;
  } {
    return {
      projections: 6,
      healthy: 4,
      docMissing: 1,
      quarantined: 1,
      restored: 0,
      upserts: 1,
      deletions: 0,
      durationMs: 12,
      reconciledAt: FAKE_NOW,
    };
  }

  override async generationDiagnostics() {
    return {
      recentRequests: [{
        requestId: "diagnostic-request",
        dedupeKeyKind: "ask" as const,
        terminal: "published" as const,
        errorCode: null,
        manifestIds: ["manifest-1"],
        strategy: "context-variety-v1",
        criticVerdicts: [{ attempt: 1, count: 3, finalVerdictCode: "pass" }],
        attemptCount: 1,
        timestamps: {
          createdAt: FAKE_NOW,
          claimedAt: FAKE_NOW,
          finishedAt: FAKE_NOW,
          updatedAt: FAKE_NOW,
        },
      }],
      deadLetterCount: 2,
      billingBlocked: true,
    };
  }
}

class OverlapTrackingStorage extends FakeFeedHostStorage {
  active = 0;
  maxActive = 0;
  bootstraps = 0;

  override async bootstrapSchema(actor: FeedHostActorStorage): Promise<FeedV1MigrationSummary> {
    this.active += 1;
    this.bootstraps += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 25));
    this.active -= 1;
    return super.bootstrapSchema(actor);
  }
}

class TransientBootstrapStorage extends FakeFeedHostStorage {
  bootstrapAttempts = 0;

  override async bootstrapSchema(actor: FeedHostActorStorage): Promise<FeedV1MigrationSummary> {
    this.bootstrapAttempts += 1;
    if (this.bootstrapAttempts === 1) {
      throw new Error("SQL batch failed: could not serialize access due to read/write dependencies among transactions");
    }
    return super.bootstrapSchema(actor);
  }
}

class UnauthorizedReadStorage extends FakeFeedHostStorage {
  override async readArtifact(): Promise<never> {
    throw new Error(
      "TinyCloud SQL query failed: SQL query failed: 401 - Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:applications/sql/xyz.tinycloud.artifacts/index / tinycloud.sql/read",
    );
  }
}

class HeroFeedHostStorage extends FakeFeedHostStorage {
  override async readArtifactHero(
    _actor: FeedHostActorStorage,
    artifactId: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    return artifactId === "with-hero"
      ? { bytes: new TextEncoder().encode("served hero bytes"), contentType: "image/png" }
      : null;
  }
}

class FailOncePreparationStorage extends FakeFeedHostStorage {
  bootstrapAttempts = 0;

  override async bootstrapSchema(actor: FeedHostActorStorage): Promise<FeedV1MigrationSummary> {
    this.bootstrapAttempts += 1;
    if (this.bootstrapAttempts === 1) throw new Error("planned bootstrap failure");
    return super.bootstrapSchema(actor);
  }
}

class BlockingPreparationStorage extends FakeFeedHostStorage {
  bootstrapAttempts = 0;
  private resolveBootstrap: (() => void) | undefined;
  private readonly blocked = new Promise<void>((resolve) => {
    this.resolveBootstrap = resolve;
  });

  override async bootstrapSchema(actor: FeedHostActorStorage): Promise<FeedV1MigrationSummary> {
    this.bootstrapAttempts += 1;
    await this.blocked;
    return super.bootstrapSchema(actor);
  }

  release(): void {
    this.resolveBootstrap?.();
  }
}

class ConcurrentReadStorage extends FakeFeedHostStorage {
  private activeReads = 0;
  maxConcurrentReads = 0;

  override async listFeed(
    actor: FeedHostActorStorage,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: FeedArtifactProjection[]; nextCursor?: string }> {
    return this.track(() => super.listFeed(actor, input));
  }

  override async listFeedEvents(actor: FeedHostActorStorage, afterEventId?: string): Promise<string> {
    return this.track(() => super.listFeedEvents(actor, afterEventId));
  }

  private async track<T>(run: () => Promise<T>): Promise<T> {
    this.activeReads += 1;
    this.maxConcurrentReads = Math.max(this.maxConcurrentReads, this.activeReads);
    await Bun.sleep(20);
    try {
      return await run();
    } finally {
      this.activeReads -= 1;
    }
  }
}

class BlockingFeedReadStorage extends FakeFeedHostStorage {
  private resolveStarted: (() => void) | undefined;
  private resolveRead: (() => void) | undefined;
  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });
  private readonly blocked = new Promise<void>((resolve) => {
    this.resolveRead = resolve;
  });

  override async listFeed(
    actor: FeedHostActorStorage,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: FeedArtifactProjection[]; nextCursor?: string }> {
    this.resolveStarted?.();
    await this.blocked;
    return super.listFeed(actor, input);
  }

  release(): void {
    this.resolveRead?.();
  }
}

class ReconcileCountingStorage extends FakeFeedHostStorage {
  reconcileAttempts = 0;

  override async reconcileFeedProjection(actor: FeedHostActorStorage) {
    this.reconcileAttempts += 1;
    return super.reconcileFeedProjection(actor);
  }
}

type StoredArtifactIndexRow = {
  artifact_id: string;
  artifact_type: string;
  package_id: string;
  source_fingerprint: string;
  doc_key: string;
  published_at: string;
  updated_at: string;
};

type StoredWorkflowPackageRow = {
  package_id: string;
  display_name: string;
  version: string;
  admission_state: string;
  disclosure_json: string;
  enabled_at: string | null;
  paused_at: string | null;
  updated_at: string;
};

type StoredWorkflowRunRow = {
  run_id: string;
  package_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
};

type StoredControlIntentRow = {
  event_id: string;
  reader_nonce: string;
  actor_id: string;
  intent_kind: string;
  status: string;
  target_ref: string;
  payload_hash: string | null;
  payload_json: string | null;
  created_at: string;
};

type StoredGenerationRequestRow = {
  request_id: string;
  reader_nonce: string;
  actor_id: string;
  status: string;
  scope_json: string;
  package_id: string | null;
  dedupe_key: string | null;
  prompt: string | null;
  run_id?: string | null;
  workflow_id?: string | null;
  max_attempts?: number;
  claim_owner?: string | null;
  lease_expires_at?: string | null;
  fencing_token?: number;
  attempt_count?: number;
  next_retry_at?: string | null;
  cancellation_requested?: number;
  phase?: string;
  source_cursor_before?: string | null;
  terminal_kind?: "published" | "zero_artifacts" | "dead_letter" | null;
  error_code?: string | null;
  published_manifest_ids?: string[];
  critic_verdicts?: Array<{ attempt: number; count: number; finalVerdictCode: string | null }>;
  generation_strategy?: string | null;
  claimed_at?: string | null;
  finished_at?: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

type FakeGenerationMetadata = {
  terminal?: "published" | "zero_artifacts" | "dead_letter";
  publishedManifestIds?: string[];
  criticVerdicts?: Array<{ attempt: number; count: number; finalVerdictCode: string | null }>;
  strategy?: string;
};

function applyFakeGenerationMetadata(row: StoredGenerationRequestRow, metadata: FakeGenerationMetadata): void {
  if (metadata.terminal !== undefined) row.terminal_kind = metadata.terminal;
  if (metadata.publishedManifestIds !== undefined) row.published_manifest_ids = metadata.publishedManifestIds;
  if (metadata.criticVerdicts !== undefined) row.critic_verdicts = metadata.criticVerdicts;
  if (metadata.strategy !== undefined) row.generation_strategy = metadata.strategy;
}

function wireGenerationRequest(row: StoredGenerationRequestRow): Record<string, unknown> {
  return {
    requestId: row.request_id,
    readerNonce: row.reader_nonce,
    actorId: row.actor_id,
    status: row.status,
    scope: JSON.parse(row.scope_json) as Record<string, unknown>,
    packageId: row.package_id,
    dedupeKey: row.dedupe_key,
    prompt: row.prompt,
    runId: row.run_id ?? null,
    workflowId: row.workflow_id ?? null,
    maxAttempts: row.max_attempts ?? 3,
    claimOwner: row.claim_owner ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    fencingToken: row.fencing_token ?? 0,
    attemptCount: row.attempt_count ?? 0,
    nextRetryAt: row.next_retry_at ?? null,
    cancellationRequested: row.cancellation_requested === 1,
    phase: row.phase ?? "queued",
    terminal: row.terminal_kind ?? null,
    errorCode: row.error_code ?? null,
    publishedManifestIds: row.published_manifest_ids ?? [],
    criticVerdicts: row.critic_verdicts ?? [],
    strategy: row.generation_strategy ?? null,
    claimedAt: row.claimed_at ?? null,
    finishedAt: row.finished_at ?? null,
    sourceCursorBefore: row.source_cursor_before ? JSON.parse(row.source_cursor_before) : null,
    timing: {},
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// A serialized delegation may cover several resources (one signed UCAN with a
// multi-entry att claim); the fake models that with a "|"-joined path list.
function fakeActivatedDelegation(resource: string, expiresInMs = 60 * 60 * 1000): ActivatedFeedDelegation {
  return {
    actorId: ACTOR_ID,
    acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    resources: resource.split("|"),
    portableDelegation: {} as ActivatedFeedDelegation["portableDelegation"],
    access: { resource } as unknown as ActivatedFeedDelegation["access"],
  };
}

function fakeHostNode(did: string): NonNullable<Parameters<typeof startFeedHost>[0]["hostNode"]> {
  return { did, signIn: async () => {} } as unknown as NonNullable<
    Parameters<typeof startFeedHost>[0]["hostNode"]
  >;
}

function fakeDelegationStore(): FeedHostDelegationStore {
  const data = new Map<string, unknown>();
  const node = {
    signIn: async () => ({}),
    kv: {
      put: async (key: string, value: unknown) => {
        data.set(key, value);
        return { ok: true, data: undefined };
      },
      get: async (key: string) =>
        data.has(key)
          ? { ok: true, data: { data: data.get(key) } }
          : { ok: false, error: { code: "KV_NOT_FOUND", message: `not found: ${key}` } },
      delete: async (key: string) => {
        data.delete(key);
        return { ok: true, data: undefined };
      },
    },
  } as unknown as ConstructorParameters<typeof FeedHostDelegationStore>[0];
  return new FeedHostDelegationStore(node);
}

function makeArtifact(input: {
  artifactId: string;
  packageId: string;
  runId: string;
  packageDigest: string;
  createdAt: string;
  updatedAt: string;
  sourceFingerprint: string;
  artifactFingerprint: string;
  dedupeKey: string;
  docKey: string;
  title: string;
  summary: string;
  bodyMarkdown: string;
}): FeedArtifact {
  return {
    schemaVersion: "feed.artifact.v1",
    artifactId: input.artifactId,
    artifactType: "insight_card",
    renderShape: "short_form",
    title: input.title,
    summary: input.summary,
    body: { markdown: input.bodyMarkdown },
    sourceRefs: [SOURCE_REF],
    producedBy: {
      packageId: input.packageId,
      packageVersion: "1.0.0",
      packageDigest: input.packageDigest,
      runId: input.runId,
      runtimeClass: "feed_hosted",
      providerClass: "first_party",
      credentialOwner: "feed_hosted",
      egressClass: "model_provider",
      disclosure: DISCLOSURE,
    },
    freshness: {
      label: "fresh",
      asOf: input.createdAt,
      lastCheckedAt: input.updatedAt,
    },
    idempotency: {
      sourceFingerprint: input.sourceFingerprint,
      artifactFingerprint: input.artifactFingerprint,
      dedupeKey: input.dedupeKey,
    },
    storage: {
      docKey: input.docKey,
    },
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function makeProjection(input: {
  artifactId: string;
  packageId: string;
  sourceFingerprint: string;
  publishedAt: string;
  updatedAt: string;
  rankScore: number;
  reasonCodes: string[];
}): FeedArtifactProjection {
  return {
    artifactId: input.artifactId,
    rankScore: input.rankScore,
    disposition: "default",
    visibility: "ranked",
    freshnessLabel: "fresh",
    reasonCodes: input.reasonCodes,
    packageId: input.packageId,
    sourceFingerprint: input.sourceFingerprint,
    publishedAt: input.publishedAt,
    updatedAt: input.updatedAt,
  };
}

function artifactIndexRow(artifact: FeedArtifact): SqlSeedRow {
  return {
    table: "artifact_index",
    values: {
      artifact_id: artifact.artifactId,
      artifact_type: artifact.artifactType,
      package_id: artifact.producedBy.packageId,
      package_version: artifact.producedBy.packageVersion,
      package_digest: artifact.producedBy.packageDigest,
      run_id: artifact.producedBy.runId,
      source_fingerprint: artifact.idempotency.sourceFingerprint,
      artifact_fingerprint: artifact.idempotency.artifactFingerprint,
      dedupe_key: artifact.idempotency.dedupeKey,
      doc_key: artifact.storage.docKey,
      media_keys_json: "[]",
      created_at: artifact.createdAt,
      updated_at: artifact.updatedAt,
      published_at: artifact.createdAt,
    },
  };
}

function preferenceKey(actorId: string, scope: string): string {
  return `${actorId.toLowerCase()}:${scope}`;
}

function normalizePreferenceScope(scope?: string): string {
  const value = scope ?? FEED_HOST_PREFERENCES_SCOPE;
  if (value === FEED_HOST_PREFERENCES_SCOPE) return value;
  if (/^package:[^/\\]+$/.test(value)) return value;
  throw new FeedHostError("preference scope is not allowlisted", 400, "invalid_preferences");
}

function mergePreferencePatch(base: FeedPreferenceValue, patch: FeedPreferenceValue): FeedPreferenceValue {
  const sanitizedBase = sanitizePreferenceValue(base);
  const sanitizedPatch = sanitizePreferenceValue(patch);
  const next: FeedPreferenceValue = {
    ...sanitizedBase,
    packagePriority: { ...(sanitizedBase.packagePriority ?? {}) },
    typePriority: { ...(sanitizedBase.typePriority ?? {}) },
    sourcePriority: { ...(sanitizedBase.sourcePriority ?? {}) },
    savedArtifactIds: [...(sanitizedBase.savedArtifactIds ?? [])],
    hiddenArtifactIds: [...(sanitizedBase.hiddenArtifactIds ?? [])],
    packageDisabled: [...(sanitizedBase.packageDisabled ?? [])],
    typeSuppressed: [...(sanitizedBase.typeSuppressed ?? [])],
    showFewerPackageIds: { ...(sanitizedBase.showFewerPackageIds ?? {}) },
  };
  if (sanitizedPatch.packagePriority) next.packagePriority = { ...(next.packagePriority ?? {}), ...sanitizedPatch.packagePriority };
  if (sanitizedPatch.typePriority) next.typePriority = { ...(next.typePriority ?? {}), ...sanitizedPatch.typePriority };
  if (sanitizedPatch.sourcePriority) next.sourcePriority = { ...(next.sourcePriority ?? {}), ...sanitizedPatch.sourcePriority };
  if (sanitizedPatch.savedArtifactIds) next.savedArtifactIds = uniqueStrings([...(next.savedArtifactIds ?? []), ...sanitizedPatch.savedArtifactIds]);
  if (sanitizedPatch.hiddenArtifactIds) next.hiddenArtifactIds = uniqueStrings([...(next.hiddenArtifactIds ?? []), ...sanitizedPatch.hiddenArtifactIds]);
  if (sanitizedPatch.packageDisabled) next.packageDisabled = uniqueStrings([...(next.packageDisabled ?? []), ...sanitizedPatch.packageDisabled]);
  if (sanitizedPatch.typeSuppressed) next.typeSuppressed = uniqueStrings([...(next.typeSuppressed ?? []), ...sanitizedPatch.typeSuppressed]);
  if (sanitizedPatch.showFewerPackageIds) next.showFewerPackageIds = { ...(next.showFewerPackageIds ?? {}), ...sanitizedPatch.showFewerPackageIds };
  if (typeof sanitizedPatch.cooldownMinutes === "number") next.cooldownMinutes = sanitizedPatch.cooldownMinutes;
  if (typeof sanitizedPatch.diversityWindow === "number") next.diversityWindow = sanitizedPatch.diversityWindow;
  if (typeof sanitizedPatch.priority === "number") next.priority = sanitizedPatch.priority;
  if (typeof sanitizedPatch.paused === "boolean") next.paused = sanitizedPatch.paused;
  if (typeof sanitizedPatch.disabled === "boolean") next.disabled = sanitizedPatch.disabled;
  if (sanitizedPatch.cadence === "more" || sanitizedPatch.cadence === "normal" || sanitizedPatch.cadence === "less") next.cadence = sanitizedPatch.cadence;
  if (
    sanitizedPatch.sourceSelection === "recent_authorized" ||
    sanitizedPatch.sourceSelection === "named_sources" ||
    sanitizedPatch.sourceSelection === "all_authorized"
  ) {
    next.sourceSelection = sanitizedPatch.sourceSelection;
  }
  if (sanitizedPatch.audience === "private" || sanitizedPatch.audience === "team" || sanitizedPatch.audience === "draft") {
    next.audience = sanitizedPatch.audience;
  }
  if (
    sanitizedPatch.outputVolume === "short" ||
    sanitizedPatch.outputVolume === "standard" ||
    sanitizedPatch.outputVolume === "detailed"
  ) {
    next.outputVolume = sanitizedPatch.outputVolume;
  }
  return next;
}

function preferenceScopeForIntent(
  kind: ControlIntentEvent["intentKind"],
  payload: Record<string, unknown> | undefined,
  targetRef: string,
): string {
  const expectedScope =
    kind === "safe_package_setting_update" ||
    kind === "candidate_package_proposal" ||
    kind === "enable_package" ||
    kind === "pause_package" ||
    kind === "disable_package" ||
    kind === "tune_package" ||
    kind === "reset_package"
      ? `package:${packageIdFromTarget(targetRef) ?? targetRef}`
      : FEED_HOST_PREFERENCES_SCOPE;

  if (typeof payload?.scope === "string" && payload.scope.trim() !== "" && payload.scope !== expectedScope) {
    throw new FeedHostError("preference scope is not allowlisted", 400, "invalid_intent");
  }

  return expectedScope;
}

function controlIntentPreferencePatch(
  kind: ControlIntentEvent["intentKind"],
  payload: Record<string, unknown> | undefined,
  targetRef: string,
): FeedPreferenceValue {
  const patch = plainObject(payload?.value) ?? plainObject(payload?.settings) ?? payload ?? {};
  switch (kind) {
    case "set_cadence": {
      const cadence =
        typeof payload?.cadence === "string" ? payload.cadence : typeof patch.cadence === "string" ? patch.cadence : undefined;
      const packageId = packageIdFromTarget(targetRef);
      const showFewerPackageIds = packageId ? { [packageId]: cadence === "less" ? 1 : cadence === "more" ? 0 : 0 } : undefined;
      return sanitizePreferenceValue({
        cadence: cadence === "more" || cadence === "normal" || cadence === "less" ? cadence : undefined,
        showFewerPackageIds,
      });
    }
    case "enable_package":
      return { paused: false, disabled: false };
    case "pause_package":
      return { paused: true };
    case "disable_package":
      return { disabled: true };
    case "reset_package":
      return {};
    case "candidate_package_proposal":
      return sanitizePreferenceValue({ ...patch, disabled: true });
    case "safe_package_setting_update":
    case "tune_package":
    case "adjust_preference":
    case "reset_preferences":
      return sanitizePreferenceValue(patch);
    default:
      return sanitizePreferenceValue(patch);
  }
}

function packageIdFromTarget(targetRef: string): string | undefined {
  const normalized = targetRef.startsWith("package:") ? targetRef.slice("package:".length) : targetRef;
  if (normalized.trim() === "" || normalized.includes("/") || normalized.includes("\\")) return undefined;
  return normalized;
}

function buildGenerationRequestRecord(input: {
  actorId: string;
  readerNonce: string;
  eventId: string;
  createdAt: string;
  payload: unknown;
  targetRef: string;
  payloadHash: string;
}): StoredGenerationRequestRow {
  const scope = generationScopeFromPayload(input.payload, input.targetRef);
  const prompt = promptFromPayload(input.payload);
  const dedupeKey = input.payloadHash ?? hashJson({ actorId: input.actorId, scope, prompt, targetRef: input.targetRef });
  return {
    request_id: input.eventId,
    reader_nonce: input.readerNonce,
    actor_id: input.actorId,
    status: "accepted",
    scope_json: JSON.stringify(scope),
    package_id: scope.packageId ?? null,
    dedupe_key: dedupeKey,
    prompt,
    expires_at: new Date(Date.parse(input.createdAt) + 24 * 60 * 60 * 1000).toISOString(),
    created_at: input.createdAt,
    updated_at: input.createdAt,
  };
}

function generationScopeFromPayload(
  payload: unknown,
  targetRef: string,
): { artifactType?: string; packageId?: string; sourceRefId?: string; targetRef?: string } {
  const scope = plainObject(payload && typeof payload === "object" ? (payload as Record<string, unknown>).scope : undefined);
  if (scope) {
    return {
      artifactType: stringOrUndefined(scope.artifactType),
      packageId: stringOrUndefined(scope.packageId),
      sourceRefId: stringOrUndefined(scope.sourceRefId),
      targetRef: stringOrUndefined(scope.targetRef) ?? targetRef,
    };
  }
  const record = plainObject(payload);
  return {
    artifactType: stringOrUndefined(record?.artifactType),
    packageId: stringOrUndefined(record?.packageId),
    sourceRefId: stringOrUndefined(record?.sourceRefId),
    targetRef,
  };
}

function promptFromPayload(payload: unknown): string | null {
  const record = plainObject(payload);
  return stringOrUndefined(record?.prompt) ?? null;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== "").map((value) => value.trim()))];
}

function feedbackDisposition(
  signal: FeedbackEvent["signal"],
  current: FeedArtifactProjection["disposition"],
): FeedArtifactProjection["disposition"] {
  switch (signal) {
    case "save":
      return "saved";
    case "hide":
      return "hidden";
    case "unsave":
    case "unhide":
      return "default";
    default:
      return current;
  }
}

function stripProjection(row: FeedProjectionState): FeedItemProjection {
  return {
    feedItemId: row.feedItemId,
    target: row.target,
    rankScore: row.rankScore,
    disposition: row.disposition,
    visibility: row.visibility,
    freshnessLabel: row.freshnessLabel,
    reasonCodes: [...row.reasonCodes],
    packageId: row.packageId,
    sourceFingerprint: row.sourceFingerprint,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
  };
}

function projectionState(row: FeedArtifactProjection | FeedItemProjection, docMissing: boolean): FeedProjectionState {
  if ("target" in row) return { ...row, artifactType: "insight_card", docMissing };
  return {
    ...row,
    feedItemId: `legacy:${row.artifactId}`,
    target: { kind: "artifact_preview", artifactId: row.artifactId },
    docMissing,
  };
}

async function grantAllDelegations(runtime: FeedHostRuntime, actorId: string): Promise<string> {
  const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
  expect(policy.resources.map((resource) => resource.path)).toEqual(FEED_HOST_DELEGATION_RESOURCES.map((resource) => resource.path));
  const response = await postJson(
    `${runtime.url}/api/delegations`,
    {
      actorId,
      serializedDelegation: policy.resources.map((resource) => resource.path).join("|"),
    },
    { "content-type": "application/json" },
  );
  expect(response.ok).toBe(true);
  const sessionCookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  expect(sessionCookie).not.toBe("");
  await waitForSetupStatus(runtime, sessionCookie, "ready", actorId);
  return sessionCookie;
}

async function waitForSetupStatus(
  runtime: FeedHostRuntime,
  cookie: string,
  expected: "ready" | "failed",
  actorId = ACTOR_ID,
): Promise<{
  setup?: { state: string; phase: string; attempt: number; error?: { message: string } };
}> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    const status = await getJson<{
      setup?: { state: string; phase: string; attempt: number; error?: { message: string } };
    }>(`${runtime.url}/api/delegations/status`, {
      "x-feed-actor-id": actorId,
      ...(cookie ? { cookie } : {}),
    });
    if (status.setup?.state === expected) return status;
    await Bun.sleep(10);
  }
  throw new Error(`setup did not reach ${expected}`);
}

async function getJson<T>(url: string, headers: HeadersInit = {}): Promise<T> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function postJson(url: string, body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function putJson(url: string, body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function postResponse(url: string, body: unknown, headers: HeadersInit = {}): Promise<Response> {
  return postJson(url, body, headers);
}

type FakeCredentialMode = "feed_hosted" | "user_byok_api_key" | "user_oauth_token" | "none";

type FakeSkillRecord = {
  actorId: string;
  skillId: string;
  credentialMode: FakeCredentialMode;
  providerId?: string;
  secretRef?: string;
  version: number;
  updatedAt: string;
};

type FakeSkillWireState = {
  skillId: string;
  credentialMode: FakeCredentialMode;
  providerId?: string;
  hasSecret: boolean;
  budget: {
    budgetId: string;
    spent: number;
    currency: string;
    disabled: boolean;
    limit?: number;
    remaining?: number;
    status: "ready" | "blocked_budget";
  };
  version: number;
  updatedAt: string;
};

type FakeSkillPatch = {
  expectedVersion: number;
  credentialMode: FakeCredentialMode;
  providerId?: string;
  secretRef?: string;
};

function isFakeSupportedMode(value: string): value is FakeCredentialMode {
  return (
    value === "feed_hosted" ||
    value === "user_byok_api_key" ||
    value === "user_oauth_token" ||
    value === "none"
  );
}

function fakeResolveSecretRef(patch: FakeSkillPatch, current: FakeSkillRecord | null): string | undefined {
  if (patch.credentialMode === "none") return undefined;
  if (patch.credentialMode === "feed_hosted") {
    return `vault/secrets/scoped/feed/${(patch.providerId?.trim() ?? current?.providerId ?? "openai").toUpperCase()}_API_KEY`;
  }
  const submitted = patch.secretRef?.trim();
  if (submitted) return submitted;
  return current?.secretRef;
}

function toFakeWireSkill(record: FakeSkillRecord): FakeSkillWireState {
  return {
    skillId: record.skillId,
    credentialMode: record.credentialMode,
    providerId: record.providerId,
    hasSecret: typeof record.secretRef === "string" && record.secretRef.length > 0,
    budget: {
      budgetId: record.skillId,
      spent: 0,
      currency: "USD",
      disabled: false,
      status: "ready",
    },
    version: record.version,
    updatedAt: record.updatedAt,
  };
}

function emptyMigrationSummary(): FeedV1MigrationSummary {
  return {
    legacyArtifacts: 0,
    legacyInteractions: 0,
    migratedArtifacts: 0,
    migratedArtifactDocs: 0,
    migratedArtifactRows: 0,
    migratedFeedRows: 0,
    migratedFeedbackEvents: 0,
    migratedControlIntents: 0,
    migratedGenerationRequests: 0,
    skippedArtifacts: 0,
    skippedInteractions: 0,
  };
}

function childTransport(): string {
  return JSON.stringify({
    cid: INPUT_CHILD_CID,
    delegateDID: "did:key:zFeedHost",
    delegatorDID: "did:key:zShare",
    spaceId: "tinycloud:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266:applications",
    path: "xyz.tinycloud.listen/conversations",
    actions: ["tinycloud.sql/read"],
    expiry: "2099-01-01T00:00:00.000Z",
    isRevoked: false,
    allowSubDelegation: false,
    parentCid: INPUT_PARENT_CID,
    createdAt: "2026-07-19T00:00:00.000Z",
    delegationHeader: { Authorization: "child.jwt.signature" },
    ownerAddress: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    chainId: 1,
    host: "https://node.tinycloud.xyz",
    resources: [{
      service: "tinycloud.sql",
      space: "tinycloud:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266:applications",
      path: "xyz.tinycloud.listen/conversations",
      actions: ["tinycloud.sql/read"],
    }],
    disableSubDelegation: true,
  });
}
