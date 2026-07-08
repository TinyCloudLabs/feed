import type {
  ControlIntentEvent,
  FeedArtifact,
  FeedArtifactProjection,
  FeedbackEvent,
} from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import type {
  FeedHostDelegationPolicy,
  FeedHostDelegationReceipt,
  FeedHostDelegationSubmission,
} from "./delegation.ts";

export type FeedV1Page = {
  items: FeedArtifactProjection[];
  nextCursor?: string;
};

export type FeedEventStream = {
  text: string;
};

export type ArtifactProvenance = Pick<FeedArtifact, "artifactId" | "sourceRefs" | "producedBy" | "freshness" | "idempotency">;

export type FeedV1HostClientOptions = {
  baseUrl: string;
  token?: string;
  actorId?: string;
  fetchImpl?: typeof fetch;
};

export class FeedV1HostError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "FeedV1HostError";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Feed Host baseUrl is required");
  return trimmed;
}

export class FeedV1HostClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token?: string;
  private readonly actorId?: string;

  constructor(options: FeedV1HostClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.token = options.token;
    this.actorId = options.actorId;
  }

  async getDelegationPolicy(): Promise<FeedHostDelegationPolicy> {
    return this.request<FeedHostDelegationPolicy>("/delegation-policy");
  }

  async submitDelegation(submission: FeedHostDelegationSubmission): Promise<FeedHostDelegationReceipt> {
    return this.request<FeedHostDelegationReceipt>("/api/delegations", {
      method: "POST",
      body: JSON.stringify(submission),
    });
  }

  async listFeed(input: { limit?: number; cursor?: string } = {}): Promise<FeedV1Page> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    return this.request<FeedV1Page>(`/feed${params.size ? `?${params}` : ""}`);
  }

  async getArtifact(artifactId: string): Promise<FeedArtifact> {
    return this.request<FeedArtifact>(`/artifacts/${encodeURIComponent(artifactId)}`);
  }

  async getProvenance(artifactId: string): Promise<ArtifactProvenance> {
    return this.request<ArtifactProvenance>(`/artifacts/${encodeURIComponent(artifactId)}/provenance`);
  }

  async postFeedback(event: FeedbackEvent): Promise<{ accepted: true; eventId: string }> {
    return this.request<{ accepted: true; eventId: string }>("/feedback", {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  async postControlIntent(event: ControlIntentEvent): Promise<{ accepted: true; eventId: string }> {
    return this.request<{ accepted: true; eventId: string }>("/control-intents", {
      method: "POST",
      body: JSON.stringify(event),
    });
  }

  async getFeedEvents(): Promise<FeedEventStream> {
    return { text: await this.requestText("/feed/events", { headers: { accept: "text/event-stream" } }) };
  }

  eventsUrl(): string {
    return `${this.baseUrl}/feed/events`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const text = await this.requestText(path, init);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async requestText(path: string, init: RequestInit = {}): Promise<string> {
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    if (this.actorId) headers.set("x-feed-actor-id", this.actorId);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    const text = await res.text();
    if (!res.ok) throw new FeedV1HostError(`Feed Host request failed: ${res.status}`, res.status, text);
    return text;
  }
}
