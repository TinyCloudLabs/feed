import { afterEach, describe, expect, test } from "bun:test";
import type {
  FeedArtifact,
  FeedArtifactProjection,
  FeedbackEvent,
  ControlIntentEvent,
} from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import type { SqlSeedRow } from "../../artifactory/skills/_shared/lib/feed-v1-bootstrap.ts";
import {
  FEED_HOST_DELEGATION_RESOURCES,
  type ActivatedFeedDelegation,
  type FeedHostDelegationPolicy,
} from "./delegation.ts";
import { SEEDED_ARTIFACT_ID } from "./seed.ts";
import type { FeedHostActorStorage, FeedHostStorage } from "./storage.ts";
import { startFeedHost, type FeedHostRuntime } from "./server.ts";

const ACTOR_ID = "did:pkh:eip155:1:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

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
});

class FakeFeedHostStorage {
  private readonly projections = new Map<string, FeedArtifactProjection>();
  private readonly artifacts = new Map<string, FeedArtifact>();
  private feedback = 0;
  private controlIntents = 0;
  private generationRequests = 0;

  async bootstrapSchema(_actor: FeedHostActorStorage): Promise<void> {}

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
    resources: [resource],
    portableDelegation: {} as ActivatedFeedDelegation["portableDelegation"],
    access: { resource } as unknown as ActivatedFeedDelegation["access"],
  };
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
