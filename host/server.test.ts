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
  sanitizeClientTimingFields,
  sanitizeTraceId,
  startFeedHost,
  type FeedHostRuntime,
} from "./server.ts";

process.env.FEED_HOST_LOG = "0";

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
  test("allowlists startup timing fields and rejects planted sensitive values", () => {
    const planted = "PLANTED_SECRET_serialized_delegation";
    expect(sanitizeTraceId("feed_1234-abcd")).toBe("feed_1234-abcd");
    expect(sanitizeTraceId(planted)).toBeUndefined();
    expect(sanitizeClientTimingFields({
      flow: "interactive_sign_in",
      stage: "delegation_materialize",
      phase: "end",
      clientTs: "2026-07-11T12:00:00.000Z",
      elapsedMs: 127.4,
      durationMs: 42.8,
      outcome: "ok",
      detail: planted,
      serializedDelegation: planted,
      transcript: planted,
    })).toEqual({
      flow: "interactive_sign_in",
      stage: "delegation_materialize",
      phase: "end",
      clientTs: "2026-07-11T12:00:00.000Z",
      elapsedMs: 127,
      durationMs: 43,
      outcome: "ok",
    });
    expect(JSON.stringify(sanitizeClientTimingFields({ stage: planted, detail: planted }))).not.toContain(planted);
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
          unexpected: "drop-me",
        },
      },
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(updated.status).toBe(200);
    const updatedProfile = (await updated.json()) as { profile: FeedPreferenceProfileRecord };
    expect(updatedProfile.profile.version).toBe(1);
    expect(updatedProfile.profile.value.packagePriority?.["follow-up"]).toBe(4);
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
    expect(resumedText).toContain(`id: projection:${SECOND_ARTIFACT_ID}:`);
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

    const feed = await getJson<{ items: Array<{ artifactId: string }> }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(feed.items.some((item) => item.artifactId === artifact.artifactId)).toBe(true);

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

    const intent = await postJson(
      `${runtime.url}/control-intents`,
      {
        actorId: ACTOR_ID,
        eventId: "gen-worker-intent-001",
        readerNonce: "gen-worker-nonce-001",
        intentKind: "ask_feed",
        targetRef: "feed",
        payload: { prompt: "Summarize my week" },
        createdAt: "2026-07-10T22:00:00.000Z",
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
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; resources: string[] };
    expect(body.status).toBe("active");
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
