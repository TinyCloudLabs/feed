import { afterEach, describe, expect, test } from "bun:test";
import type {
  FeedArtifact,
  FeedArtifactProjection,
  FeedbackEvent,
  ControlIntentEvent,
} from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import type { FeedV1MigrationSummary } from "../../artifactory/skills/_shared/lib/feed-v1-migration.ts";
import type { SqlSeedRow } from "../../artifactory/skills/_shared/lib/feed-v1-bootstrap.ts";
import {
  FEED_HOST_DELEGATION_RESOURCES,
  type ActivatedFeedDelegation,
  type FeedHostDelegationPolicy,
} from "./delegation.ts";
import { FeedHostDelegationStore } from "./delegation-store.ts";
import { SEEDED_ARTIFACT_ID } from "./seed.ts";
import type { FeedHostActorStorage, FeedHostStorage } from "./storage.ts";
import { startFeedHost, type FeedHostRuntime } from "./server.ts";

const ACTOR_ID = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
// Stable host identity used for restart coverage. In production this comes
// from FEED_HOST_PRIVATE_KEY: the host signs in and its did:pkh stays stable.
const HOST_DID = "did:pkh:eip155:1:0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

let runtime: FeedHostRuntime | null = null;

afterEach(() => {
  runtime?.stop();
  runtime = null;
});

describe("Feed Host server", () => {
  test("serves seeded projections and records feedback/control intents through delegated actor storage", async () => {
    const storage = new FakeFeedHostStorage();
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: storage as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const blockedFeed = await fetch(`${runtime.url}/feed?limit=10`, { headers: { "x-feed-actor-id": ACTOR_ID } });
    expect(blockedFeed.status).toBe(403);

    const policy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    expect(policy.resources.map((resource) => resource.path)).toEqual(FEED_HOST_DELEGATION_RESOURCES.map((resource) => resource.path));
    expect(policy.resources.map((resource) => resource.path)).toEqual([
      "xyz.tinycloud.artifacts/index",
      "xyz.tinycloud.feed/index",
      "xyz.tinycloud.artifacts/artifacts",
    ]);
    for (const resource of policy.resources) {
      await postJson(`${runtime.url}/delegations`, {
        actorId: ACTOR_ID,
        serializedDelegation: resource.path,
      });
    }

    const feed = await getJson<{ items: { artifactId: string; disposition: string }[] }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0].artifactId).toBe(SEEDED_ARTIFACT_ID);

    const artifact = await getJson<{ title: string; body: { markdown: string } }>(
      `${runtime.url}/artifacts/${encodeURIComponent(SEEDED_ARTIFACT_ID)}`,
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(artifact.title).toBe("Practice Fish First");
    expect(artifact.body.markdown).toContain("fundraising workflow");

    const feedbackResponse = await postJson<{ accepted: true; eventId: string }>(`${runtime.url}/feedback`, {
      eventId: "feedback-test-001",
      artifactId: SEEDED_ARTIFACT_ID,
      actorId: ACTOR_ID,
      readerNonce: "feedback-nonce-001",
      signal: "save",
      createdAt: "2026-06-29T12:05:00.000Z",
    });
    expect(feedbackResponse.accepted).toBe(true);

    const updatedFeed = await getJson<{ items: { artifactId: string; disposition: string }[] }>(`${runtime.url}/feed?limit=10`, {
      "x-feed-actor-id": ACTOR_ID,
    });
    expect(updatedFeed.items[0].disposition).toBe("saved");

    await postJson(`${runtime.url}/control-intents`, {
      eventId: "intent-test-001",
      actorId: ACTOR_ID,
      readerNonce: "intent-nonce-001",
      intentKind: "ask_feed",
      status: "accepted",
      targetRef: "feed",
      payload: { prompt: "Generate another seed artifact." },
      createdAt: "2026-06-29T12:06:00.000Z",
    });

    const state = await getJson<{ feedback: number; controlIntents: number; generationRequests: number }>(
      `${runtime.url}/admin/state`,
      { "x-feed-actor-id": ACTOR_ID },
    );
    expect(state.feedback).toBe(1);
    expect(state.controlIntents).toBe(1);
    expect(state.generationRequests).toBe(1);
  });

  test("binds delegations to the validated actor identity", async () => {
    runtime = startFeedHost({
      port: 0,
      hostname: "127.0.0.1",
      seedOnStart: true,
      storage: new FakeFeedHostStorage() as unknown as FeedHostStorage,
      activateDelegation: async ({ serializedDelegation }) => fakeActivatedDelegation(serializedDelegation),
    });

    const response = await fetch(`${runtime.url}/delegations`, {
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
    for (const resource of policy.resources) {
      await postJson(`${runtime.url}/delegations`, {
        actorId: ACTOR_ID,
        serializedDelegation: resource.path,
      });
    }
    const stored = await store.load(ACTOR_ID);
    expect(stored?.delegateDID).toBe(policy.delegateDID);
    expect(stored?.resources.map((resource) => resource.path).sort()).toEqual(
      policy.resources.map((resource) => resource.path).sort(),
    );
    runtime.stop();

    // Same stable host key and same store, fresh process state: the actor
    // must work without resubmitting delegations.
    runtime = startFeedHost(serverOptions());
    const restartedPolicy = await getJson<FeedHostDelegationPolicy>(`${runtime.url}/delegation-policy`);
    expect(restartedPolicy.delegateDID).toBe(policy.delegateDID);
    const feed = await getJson<{ items: { artifactId: string }[] }>(`${runtime.url}/feed?limit=10`, {
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
  private readonly projections = new Map<string, FeedArtifactProjection>();
  private readonly artifacts = new Map<string, FeedArtifact>();
  private feedback = 0;
  private controlIntents = 0;
  private generationRequests = 0;

  async bootstrapSchema(_actor: FeedHostActorStorage): Promise<FeedV1MigrationSummary> {
    return emptyMigrationSummary();
  }

  async hasArtifacts(_actor: FeedHostActorStorage): Promise<boolean> {
    return this.artifacts.size > 0;
  }

  async insertSeedRows(_actor: FeedHostActorStorage, _dbName: string, rows: SqlSeedRow[]): Promise<void> {
    for (const row of rows) {
      if (row.table === "feed_artifact_projection") {
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
      }
    }
  }

  async writeArtifactDocument(_actor: FeedHostActorStorage, artifact: FeedArtifact): Promise<void> {
    this.artifacts.set(artifact.artifactId, artifact);
  }

  async listFeed(_actor: FeedHostActorStorage): Promise<{ items: FeedArtifactProjection[] }> {
    return { items: [...this.projections.values()] };
  }

  async getArtifact(_actor: FeedHostActorStorage, artifactId: string): Promise<FeedArtifact | null> {
    return this.artifacts.get(artifactId) ?? null;
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

  async recordFeedback(_actor: FeedHostActorStorage, event: FeedbackEvent): Promise<void> {
    this.feedback += 1;
    const projection = this.projections.get(event.artifactId);
    if (projection) this.projections.set(event.artifactId, { ...projection, disposition: "saved" });
  }

  async recordControlIntent(_actor: FeedHostActorStorage, event: ControlIntentEvent): Promise<void> {
    this.controlIntents += 1;
    if (event.intentKind === "ask_feed") this.generationRequests += 1;
  }

  async debugState(_actor: FeedHostActorStorage): Promise<{
    artifacts: number;
    projections: number;
    feedback: number;
    controlIntents: number;
    generationRequests: number;
  }> {
    return {
      artifacts: this.artifacts.size,
      projections: this.projections.size,
      feedback: this.feedback,
      controlIntents: this.controlIntents,
      generationRequests: this.generationRequests,
    };
  }
}

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

async function getJson<T>(url: string, headers: HeadersInit = {}): Promise<T> {
  const response = await fetch(url, { headers });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
}

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as T;
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
