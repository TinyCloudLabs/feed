import { afterEach, describe, expect, test } from "bun:test";
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
import { FeedHostError, type FeedHostActorStorage, type FeedHostStorage } from "./storage.ts";
import { startFeedHost, type FeedHostRuntime } from "./server.ts";

const ACTOR_ID = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const OTHER_ACTOR_ID = "did:pkh:eip155:1:0x0000000000000000000000000000000000000001";
const MUTATING_ROUTES = ["/feedback", "/control-intents"] as const;
// Stable host identity used for restart coverage. In production this comes
// from FEED_HOST_PRIVATE_KEY: the host signs in and its did:pkh stays stable.
const HOST_DID = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SECOND_ARTIFACT_ID = "run-seed-002:insight-card-001";
const FAKE_NOW = "2026-07-20T00:00:00.000Z";

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
    expect(policy.resources.map((resource) => resource.path)).toEqual(FEED_HOST_DELEGATION_RESOURCES.map((resource) => resource.path));

    const openApi = await getJson<{ paths: Record<string, unknown> }>(`${runtime.url}/api/openapi.json`);
    expect(Object.keys(openApi.paths).sort()).toEqual(
      [
        "/health",
        "/delegation-policy",
        "/api/server-info",
        "/api/delegations",
        "/api/delegations/status",
        "/api/openapi.json",
        "/admin/state",
        "/admin/seed",
        "/feed",
        "/feed/events",
        "/artifacts/{artifactId}",
        "/artifacts/{artifactId}/provenance",
        "/feedback",
        "/control-intents",
        "/preferences",
        "/generation-requests",
      ].sort(),
    );
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
        createdAt: "2026-06-29T11:59:00.000Z",
        updatedAt: "2026-06-29T11:59:00.000Z",
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
        publishedAt: "2026-06-29T11:59:00.000Z",
        updatedAt: "2026-06-29T11:59:00.000Z",
        rankScore: 0.58,
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

    const before = await getJson<{ items: Array<{ artifactId: string }> }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(before.items.map((item) => item.artifactId)[0]).toBe(SEEDED_ARTIFACT_ID);

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
            "follow-up": 4,
          },
        },
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(updated.status).toBe(200);
    const updatedProfile = (await updated.json()) as { profile: FeedPreferenceProfileRecord };
    expect(updatedProfile.profile.version).toBe(1);
    expect(updatedProfile.profile.value.packagePriority?.["follow-up"]).toBe(4);
    const after = await getJson<{ items: Array<{ artifactId: string }> }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(after.items.map((item) => item.artifactId)[0]).toBe(SECOND_ARTIFACT_ID);

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

    const updatedFeed = await getJson<{ items: Array<{ artifactId: string; disposition: string }> }>(
      `${runtime.url}/feed?limit=10`,
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(updatedFeed.items[0].disposition).toBe("saved");
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

    storage.addArtifactFixture(
      makeArtifact({
        artifactId: SECOND_ARTIFACT_ID,
        packageId: "follow-up",
        runId: "run-seed-002",
        packageDigest: "sha256:fixture-package-follow-up",
        createdAt: "2026-06-29T12:10:00.000Z",
        updatedAt: "2026-06-29T12:10:00.000Z",
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
        publishedAt: "2026-06-29T12:10:00.000Z",
        updatedAt: "2026-06-29T12:10:00.000Z",
        rankScore: 0.42,
        reasonCodes: ["fixture"],
      }),
      {
        runId: "run-seed-002",
        packageId: "follow-up",
        status: "published",
        startedAt: "2026-06-29T12:10:00.000Z",
        finishedAt: "2026-06-29T12:10:00.000Z",
      },
    );

    const resumedResponse = await fetch(`${runtime.url}/feed/events`, {
      headers: {
        "x-feed-actor-id": ACTOR_ID,
        "last-event-id": eventIds[0],
      },
    });
    expect(resumedResponse.ok).toBe(true);
    const resumedText = await resumedResponse.text();
    expect(resumedText).not.toContain(`id: ${eventIds[0]}`);
    expect(resumedText).toContain(`id: projection:${SECOND_ARTIFACT_ID}:`);
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
    const feed = await getJson<{ items: Array<{ artifactId: string }> }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].artifactId).toBe(SEEDED_ARTIFACT_ID);
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

class FakeFeedHostStorage {
  private readonly artifactIndex = new Map<string, StoredArtifactIndexRow>();
  private readonly artifacts = new Map<string, FeedArtifact>();
  private readonly projections = new Map<string, FeedArtifactProjection>();
  private readonly runs = new Map<string, StoredWorkflowRunRow>();
  private readonly preferenceProfiles = new Map<string, FeedPreferenceProfileRecord>();
  private readonly feedbackEvents: FeedbackEvent[] = [];
  private readonly controlIntents: StoredControlIntentRow[] = [];
  private readonly generationRequests: StoredGenerationRequestRow[] = [];

  async bootstrapSchema(_actor: FeedHostActorStorage): Promise<FeedV1MigrationSummary> {
    return emptyMigrationSummary();
  }

  async hasArtifacts(_actor: FeedHostActorStorage): Promise<boolean> {
    return this.artifactIndex.size > 0;
  }

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
    return this.preferenceProfiles.get(preferenceKey(actor.actorId, scope)) ?? null;
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
    const scope = input.scope ?? "presentation";
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

    const base = current?.value ?? (scope === "presentation" ? defaultFeedPreferences() : {});
    const value = input.reset
      ? scope === "presentation"
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
    for (const artifactId of plan.deletions) this.projections.delete(artifactId);
    for (const row of plan.upserts) this.projections.set(row.artifactId, stripProjection(row));
    return plan;
  }

  async recordFeedback(
    _actor: FeedHostActorStorage,
    event: FeedbackEvent,
  ): Promise<{ eventId: string; duplicate: boolean; status: "applied" | "noop" }> {
    const existing = this.feedbackEvents.find(
      (row) => row.actorId === event.actorId && row.readerNonce === event.readerNonce,
    );
    if (existing) return { eventId: existing.eventId, duplicate: true, status: "noop" };

    this.feedbackEvents.push(event);
    const projection = this.projections.get(event.artifactId);
    if (projection) {
      this.projections.set(event.artifactId, {
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
    const row: StoredControlIntentRow = {
      event_id: event.eventId,
      reader_nonce: event.readerNonce,
      actor_id: event.actorId,
      intent_kind: normalizedKind,
      status: normalizedKind === "generate_new_request" ? "accepted" : "applied",
      target_ref: event.targetRef,
      payload_hash: payloadHash,
      payload_json: event.payload === undefined ? null : JSON.stringify(event.payload),
      created_at: event.createdAt,
    };
    this.controlIntents.unshift(row);

    if (normalizedKind === "generate_new_request") {
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
      return { eventId: event.eventId, duplicate: false, status: "accepted", requestId: request.request_id };
    }

    return { eventId: event.eventId, duplicate: false, status: row.status };
  }

  async listControlIntents(_actor: FeedHostActorStorage, limit = 100): Promise<StoredControlIntentRow[]> {
    return this.controlIntents.slice(0, Math.max(1, Math.min(limit, 500)));
  }

  async listGenerationRequests(_actor: FeedHostActorStorage, limit = 100): Promise<StoredGenerationRequestRow[]> {
    return this.generationRequests.slice(0, Math.max(1, Math.min(limit, 500)));
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

type StoredArtifactIndexRow = {
  artifact_id: string;
  artifact_type: string;
  package_id: string;
  source_fingerprint: string;
  doc_key: string;
  published_at: string;
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
  expires_at: string;
  created_at: string;
  updated_at: string;
};

function fakeActivatedDelegation(resource: string): ActivatedFeedDelegation {
  return {
    actorId: ACTOR_ID,
    acceptedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    resources: [resource],
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

function mergePreferencePatch(base: FeedPreferenceValue, patch: FeedPreferenceValue): FeedPreferenceValue {
  const next: FeedPreferenceValue = {
    ...base,
    packagePriority: { ...(base.packagePriority ?? {}) },
    typePriority: { ...(base.typePriority ?? {}) },
    sourcePriority: { ...(base.sourcePriority ?? {}) },
    savedArtifactIds: [...(base.savedArtifactIds ?? [])],
    hiddenArtifactIds: [...(base.hiddenArtifactIds ?? [])],
    packageDisabled: [...(base.packageDisabled ?? [])],
    typeSuppressed: [...(base.typeSuppressed ?? [])],
    showFewerPackageIds: { ...(base.showFewerPackageIds ?? {}) },
  };
  if (patch.packagePriority) next.packagePriority = { ...(next.packagePriority ?? {}), ...patch.packagePriority };
  if (patch.typePriority) next.typePriority = { ...(next.typePriority ?? {}), ...patch.typePriority };
  if (patch.sourcePriority) next.sourcePriority = { ...(next.sourcePriority ?? {}), ...patch.sourcePriority };
  if (patch.savedArtifactIds) next.savedArtifactIds = uniqueStrings([...(next.savedArtifactIds ?? []), ...patch.savedArtifactIds]);
  if (patch.hiddenArtifactIds) next.hiddenArtifactIds = uniqueStrings([...(next.hiddenArtifactIds ?? []), ...patch.hiddenArtifactIds]);
  if (patch.packageDisabled) next.packageDisabled = uniqueStrings([...(next.packageDisabled ?? []), ...patch.packageDisabled]);
  if (patch.typeSuppressed) next.typeSuppressed = uniqueStrings([...(next.typeSuppressed ?? []), ...patch.typeSuppressed]);
  if (patch.showFewerPackageIds) next.showFewerPackageIds = { ...(next.showFewerPackageIds ?? {}), ...patch.showFewerPackageIds };
  if (typeof patch.cooldownMinutes === "number") next.cooldownMinutes = patch.cooldownMinutes;
  if (typeof patch.diversityWindow === "number") next.diversityWindow = patch.diversityWindow;
  if (typeof patch.priority === "number") next.priority = patch.priority;
  if (typeof patch.paused === "boolean") next.paused = patch.paused;
  if (typeof patch.disabled === "boolean") next.disabled = patch.disabled;
  if (patch.cadence === "more" || patch.cadence === "normal" || patch.cadence === "less") next.cadence = patch.cadence;
  return next;
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

function stripProjection(row: FeedProjectionState): FeedArtifactProjection {
  return {
    artifactId: row.artifactId,
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

function projectionState(row: FeedArtifactProjection, docMissing: boolean): FeedProjectionState {
  return {
    ...row,
    docMissing,
  };
}

async function grantAllDelegations(runtime: FeedHostRuntime, actorId: string): Promise<void> {
  const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
  expect(policy.resources.map((resource) => resource.path)).toEqual(FEED_HOST_DELEGATION_RESOURCES.map((resource) => resource.path));
  for (const resource of policy.resources) {
    const response = await postJson(
      `${runtime.url}/api/delegations`,
      {
        actorId,
        serializedDelegation: resource.path,
      },
      { "content-type": "application/json" },
    );
    expect(response.ok).toBe(true);
  }
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
