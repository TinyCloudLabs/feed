import type {
  ControlIntentEvent,
  CredentialMode,
  FeedArtifact,
} from "../../../artifactory/skills/_shared/lib/feed-v1.ts";
import type { FeedItemProjection, FeedTargetedInteractionEvent } from "../../shared/feed-item.ts";
import type {
  FeedHostDelegationPolicy,
  FeedHostDelegationReceipt,
  FeedHostDelegationSubmission,
} from "./delegation.ts";
import type { ChildInputAuthoritySubmission } from "./inputAuthority.ts";

export type FeedV1Page = {
  items: FeedItemProjection[];
  nextCursor?: string;
};

export type FeedEventStream = {
  text: string;
};

export type ArtifactProvenance = Pick<FeedArtifact, "artifactId" | "sourceRefs" | "producedBy" | "freshness" | "idempotency">;

export type FeedHostSkillBudgetState = {
  budgetId: string;
  limit?: number;
  spent: number;
  currency: string;
  disabled: boolean;
  remaining?: number;
  status: "ready" | "blocked_budget";
};

// The wire type does NOT carry secretRef; only a hasSecret boolean marker.
// The Feed Host redacts submitted credential references so they never round
// trip through GET or PATCH responses.
export type FeedHostSkillState = {
  skillId: string;
  credentialMode: CredentialMode;
  providerId?: string;
  hasSecret: boolean;
  budget: FeedHostSkillBudgetState;
  version: number;
  updatedAt: string;
};

export type FeedHostSkillsPage = {
  items: FeedHostSkillState[];
  nextCursor?: string;
};

// Human-readable routine state for workflow controls (TC-182). Mirrors the
// host redaction: no digests, manifest/workflow refs, budget ids, DIDs, or
// capability paths — those stay behind advanced diagnostics.
export type FeedHostWorkflowPresentation = {
  schemaVersion: "feed.workflow_presentation.v1";
  purpose: string;
  triggerLabel: string;
  cadenceLabel: string;
  sourcesLabel: string;
  audienceLabel: string;
  exampleTitles: string[];
};

export type FeedHostWorkflowRunSummary = {
  runId: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  publishedArtifactCount: number;
  error?: { code: string; message: string };
};

export type FeedHostWorkflowState = {
  packageId: string;
  displayName: string;
  version: string;
  admissionState: "candidate" | "enabled_local" | "reviewed_first_party" | "blocked";
  disclosure: {
    userCopy: string;
    credentialOwner: string;
    providerClass: string;
    egressClass: string;
  };
  presentation?: FeedHostWorkflowPresentation;
  paused: boolean;
  disabled: boolean;
  cadence?: "more" | "normal" | "less";
  enabledAt: string | null;
  updatedAt: string;
  lastRun?: FeedHostWorkflowRunSummary;
  example?: { artifactId: string; title: string | null; publishedAt: string };
};

export type FeedHostWorkflowsPage = {
  items: FeedHostWorkflowState[];
  nextCursor?: string;
};

export type FeedHostInputAuthority = {
  sourceId: string;
  displayName: string;
  actorId: string;
  host: string;
  space: string;
  path: string;
  actions: string[];
  expiry: string;
  parentCid?: string;
  parentLineage?: string[];
  agentDID: string;
  attachedAt: string;
  revokedAt?: string;
  unavailableAt?: string;
  hasPortableDelegation: true;
  state: "active" | "expired" | "revoked" | "unavailable";
};

export type FeedHostSkillCredentialsPatch = {
  expectedVersion: number;
  credentialMode: CredentialMode;
  providerId?: string;
  secretRef?: string;
  budget?: {
    budgetId?: string;
    limit?: number;
    spent?: number;
    currency?: string;
    disabled?: boolean;
  };
};

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

  async disconnectFeed(): Promise<void> {
    await this.request<void>("/api/delegations", { method: "DELETE" });
  }

  async listInputAuthorities(): Promise<{ items: FeedHostInputAuthority[] }> {
    return this.request<{ items: FeedHostInputAuthority[] }>("/input-authorities");
  }

  async attachInputAuthority(submission: ChildInputAuthoritySubmission): Promise<{ attached: true; item: FeedHostInputAuthority }> {
    return this.request<{ attached: true; item: FeedHostInputAuthority }>("/input-authorities", {
      method: "POST",
      body: JSON.stringify(submission),
    });
  }

  async inspectInputAuthority(sourceId: string): Promise<FeedHostInputAuthority> {
    return this.request<FeedHostInputAuthority>(`/input-authorities/${encodeURIComponent(sourceId)}`);
  }

  async inputAuthorityStatus(sourceId: string): Promise<Pick<FeedHostInputAuthority, "sourceId" | "state" | "expiry" | "revokedAt">> {
    return this.request(`/input-authorities/${encodeURIComponent(sourceId)}/status`);
  }

  async revokeInputAuthority(sourceId: string): Promise<{ revoked: true; item: FeedHostInputAuthority }> {
    return this.request(`/input-authorities/${encodeURIComponent(sourceId)}/revoke`, { method: "POST" });
  }

  async removeInputAuthority(sourceId: string): Promise<void> {
    await this.request<void>(`/input-authorities/${encodeURIComponent(sourceId)}`, { method: "DELETE" });
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

  async listSkills(input: { limit?: number; cursor?: string } = {}): Promise<FeedHostSkillsPage> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    return this.request<FeedHostSkillsPage>(`/skills${params.size ? `?${params}` : ""}`);
  }

  async listWorkflows(input: { limit?: number; cursor?: string } = {}): Promise<FeedHostWorkflowsPage> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor) params.set("cursor", input.cursor);
    return this.request<FeedHostWorkflowsPage>(`/workflows${params.size ? `?${params}` : ""}`);
  }

  async patchSkillCredentials(
    skillId: string,
    patch: FeedHostSkillCredentialsPatch,
  ): Promise<{ updated: true; skill: FeedHostSkillState }> {
    return this.request<{ updated: true; skill: FeedHostSkillState }>(
      `/skills/${encodeURIComponent(skillId)}/credentials`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
  }

  async postFeedback(event: FeedTargetedInteractionEvent): Promise<{ accepted: true; eventId: string }> {
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
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers, credentials: "include" });
    const text = await res.text();
    if (!res.ok) throw new FeedV1HostError(`Feed Host request failed: ${res.status}`, res.status, text);
    return text;
  }
}
