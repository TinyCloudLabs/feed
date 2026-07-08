import { createHash } from "node:crypto";
import type { FeedArtifact, FeedArtifactProjection } from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import type { FeedHostDelegationPolicy } from "./delegation.ts";

export const FEED_HOST_SCHEMA_VERSION = "feed.v1";
export const FEED_HOST_RANKING_VERSION = "feed.rank.v1";
export const FEED_HOST_POLICY_VERSION = "feed.policy.v1";
export const FEED_HOST_RUNTIME_ADAPTER_VERSION = "tinycloud-node-sdk@2.4.0-beta.15";
export const FEED_HOST_PREFERENCES_SCOPE = "presentation";

export type FeedPreferenceValue = {
  packagePriority?: Record<string, number>;
  typePriority?: Record<string, number>;
  sourcePriority?: Record<string, number>;
  savedArtifactIds?: string[];
  hiddenArtifactIds?: string[];
  packageDisabled?: string[];
  typeSuppressed?: string[];
  showFewerPackageIds?: Record<string, number>;
  cooldownMinutes?: number;
  diversityWindow?: number;
  priority?: number;
  paused?: boolean;
  disabled?: boolean;
  cadence?: "more" | "normal" | "less";
  [key: string]: unknown;
};

export type FeedPreferenceProfileRecord = {
  profileId: string;
  actorId: string;
  scope: string;
  value: FeedPreferenceValue;
  version: number;
  updatedAt: string;
};

export type FeedPreferenceAggregate = {
  presentation: FeedPreferenceValue;
  packageScopes: Map<string, FeedPreferenceValue>;
};

export type FeedFeedbackSummary = {
  saved: number;
  hidden: number;
  helpful: number;
  unhelpful: number;
  showFewer: number;
  lastEventAt?: string;
};

export type FeedProjectionState = {
  artifactId: string;
  artifactType: string;
  packageId: string;
  sourceFingerprint: string;
  publishedAt: string;
  updatedAt: string;
  freshnessLabel: FeedArtifact["freshness"]["label"];
  disposition: FeedArtifactProjection["disposition"];
  visibility: FeedArtifactProjection["visibility"];
  reasonCodes: string[];
  rankScore: number;
  docMissing: boolean;
};

export type FeedReconcileArtifact = {
  artifactId: string;
  artifactType: string;
  packageId: string;
  sourceFingerprint: string;
  publishedAt: string;
  updatedAt: string;
  freshnessLabel: FeedArtifact["freshness"]["label"];
  docMissing: boolean;
};

export type FeedReconcilePlan = {
  desired: FeedProjectionState[];
  upserts: FeedProjectionState[];
  deletions: string[];
  checkpoint: {
    checkpointId: string;
    sourceKind: string;
    artifactCursor: string;
    lastReconciledAt: string;
    status: string;
  };
};

export type FeedHostServerInfo = {
  did: string;
  policyHash: string;
  status: "ready";
  permissions: Array<{
    service: string;
    path: string;
    actions: string[];
  }>;
  features: {
    preferences: boolean;
    generationRequests: boolean;
    controlIntents: boolean;
    reconciliation: boolean;
    openapi: boolean;
    feedEvents: boolean;
  };
  versions: {
    schema: string;
    ranking: string;
    policy: string;
    runtimeAdapter: string;
  };
};

export type FeedSseEvent = {
  id: string;
  event: "artifact-published" | "projection-updated";
  data: Record<string, unknown>;
};

export type FeedControlIntentKind =
  | "set_artifact_visibility"
  | "set_saved"
  | "adjust_preference"
  | "set_cadence"
  | "generate_new_request"
  | "safe_package_setting_update"
  | "reset_preferences"
  | "candidate_package_proposal"
  | "enable_package"
  | "pause_package"
  | "disable_package"
  | "tune_package"
  | "reset_package"
  | "ask_feed";

export type FeedControlIntentInput = {
  eventId: string;
  actorId?: string;
  readerNonce: string;
  intentKind: FeedControlIntentKind;
  status?: string;
  targetRef: string;
  payload?: unknown;
  payloadHash?: string | null;
  createdAt: string;
};

export type FeedGenerationRequestRecord = {
  requestId: string;
  readerNonce: string;
  actorId: string;
  status: "accepted" | "pending" | "blocked" | "rejected" | "consumed" | "expired";
  scope: { artifactType?: string; packageId?: string; sourceRefId?: string; targetRef?: string };
  packageId: string | null;
  dedupeKey: string | null;
  prompt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

export function createPolicyHash(policy: FeedHostDelegationPolicy): string {
  return hashJson({
    delegateDID: policy.delegateDID,
    resources: policy.resources.map((resource) => ({
      service: resource.service,
      path: resource.path,
      actions: [...resource.actions].sort(),
    })),
  });
}

export function buildServerInfo(policy: FeedHostDelegationPolicy): FeedHostServerInfo {
  return {
    did: policy.delegateDID,
    policyHash: createPolicyHash(policy),
    status: "ready",
    permissions: policy.resources.map((resource) => ({
      service: resource.service,
      path: resource.path,
      actions: [...resource.actions],
    })),
    features: {
      preferences: true,
      generationRequests: true,
      controlIntents: true,
      reconciliation: true,
      openapi: true,
      feedEvents: true,
    },
    versions: {
      schema: FEED_HOST_SCHEMA_VERSION,
      ranking: FEED_HOST_RANKING_VERSION,
      policy: FEED_HOST_POLICY_VERSION,
      runtimeAdapter: FEED_HOST_RUNTIME_ADAPTER_VERSION,
    },
  };
}

export function defaultFeedPreferences(): FeedPreferenceValue {
  return {
    packagePriority: {},
    typePriority: {},
    sourcePriority: {},
    savedArtifactIds: [],
    hiddenArtifactIds: [],
    packageDisabled: [],
    typeSuppressed: [],
    showFewerPackageIds: {},
    cooldownMinutes: 120,
    diversityWindow: 3,
  };
}

export function mergeFeedPreferences(records: readonly FeedPreferenceProfileRecord[]): FeedPreferenceAggregate {
  const aggregate = defaultFeedPreferences();
  const packageScopes = new Map<string, FeedPreferenceValue>();
  for (const record of records) {
    const value = sanitizePreferenceValue(record.value);
    if (record.scope === FEED_HOST_PREFERENCES_SCOPE) {
      mergePreferenceValue(aggregate, value);
      continue;
    }
    packageScopes.set(record.scope, value);
  }
  return { presentation: aggregate, packageScopes };
}

export function summarizeFeedbackEvents(
  rows: readonly {
    artifactId: string;
    signal: string;
    createdAt: string;
  }[],
): Map<string, FeedFeedbackSummary> {
  const summaries = new Map<string, FeedFeedbackSummary>();
  for (const row of rows) {
    const current = summaries.get(row.artifactId) ?? {
      saved: 0,
      hidden: 0,
      helpful: 0,
      unhelpful: 0,
      showFewer: 0,
    };
    switch (row.signal) {
      case "save":
        current.saved += 1;
        break;
      case "unsave":
        current.saved = Math.max(0, current.saved - 1);
        break;
      case "hide":
        current.hidden += 1;
        break;
      case "unhide":
        current.hidden = Math.max(0, current.hidden - 1);
        break;
      case "helpful":
        current.helpful += 1;
        break;
      case "unhelpful":
        current.unhelpful += 1;
        break;
      case "show_fewer":
        current.showFewer += 1;
        break;
      default:
        break;
    }
    if (!current.lastEventAt || row.createdAt > current.lastEventAt) {
      current.lastEventAt = row.createdAt;
    }
    summaries.set(row.artifactId, current);
  }
  return summaries;
}

export function rankFeedProjections(input: {
  items: readonly FeedProjectionState[];
  preferences?: FeedPreferenceAggregate;
  feedbackByArtifact?: Map<string, FeedFeedbackSummary>;
  now?: Date;
}): FeedProjectionState[] {
  const preferences = input.preferences ?? { presentation: defaultFeedPreferences(), packageScopes: new Map() };
  const feedbackByArtifact = input.feedbackByArtifact ?? new Map<string, FeedFeedbackSummary>();
  const now = input.now ?? new Date();
  const clusters = sourceFingerprintClusters(input.items);

  const preliminary = input.items.map((item) => scoreRank(item, preferences, feedbackByArtifact, clusters, now));
  preliminary.sort(compareRanked);

  const diversityWindow = Math.max(1, Math.trunc(preferences.presentation.diversityWindow ?? 3));
  const packageHistory = new Map<string, number>();
  const diversified = preliminary.map((item, index) => {
    const recent = preliminary.slice(Math.max(0, index - diversityWindow + 1), index);
    const repeats = recent.filter((candidate) => candidate.packageId === item.packageId).length;
    if (repeats === 0) return item;
    const penalty = 0.08 * repeats;
    return {
      ...item,
      rankScore: clampScore(item.rankScore - penalty),
      reasonCodes: uniqueReasons([...item.reasonCodes, "diversity_adjusted"]),
    };
  });
  diversified.sort(compareRanked);

  // Keep package history referenced so TypeScript does not elide the helper
  // during dead-code sweeping in downstream tooling.
  packageHistory.clear();
  return diversified;
}

export function reconcileFeedProjections(input: {
  artifacts: readonly FeedReconcileArtifact[];
  projections: readonly FeedProjectionState[];
  now?: Date;
}): FeedReconcilePlan {
  const now = input.now ?? new Date();
  const currentById = new Map(input.projections.map((row) => [row.artifactId, row] as const));
  const artifactIds = new Set<string>();
  const duplicateClusters = sourceFingerprintClusters(input.artifacts);
  const desired = input.artifacts.map((artifact) => {
    artifactIds.add(artifact.artifactId);
    const current = currentById.get(artifact.artifactId);
    const baseRow: FeedProjectionState = current
      ? {
          ...current,
          artifactType: artifact.artifactType,
          packageId: artifact.packageId,
          sourceFingerprint: artifact.sourceFingerprint,
          publishedAt: artifact.publishedAt,
          updatedAt: artifact.updatedAt,
          freshnessLabel: artifact.freshnessLabel,
          docMissing: artifact.docMissing,
          visibility: artifact.docMissing
            ? "repair_only"
            : current.visibility === "repair_only"
              ? "ranked"
              : current.visibility,
          reasonCodes: canonicalReasonCodes({
            baseReasons: current.reasonCodes,
            artifact,
            duplicateClusters,
            now,
            docMissing: artifact.docMissing,
          }),
          rankScore: current.rankScore,
        }
      : {
          artifactId: artifact.artifactId,
          artifactType: artifact.artifactType,
          packageId: artifact.packageId,
          sourceFingerprint: artifact.sourceFingerprint,
          publishedAt: artifact.publishedAt,
          updatedAt: artifact.updatedAt,
          freshnessLabel: artifact.freshnessLabel,
          disposition: "default",
          visibility: artifact.docMissing ? "repair_only" : "ranked",
          reasonCodes: canonicalReasonCodes({
            baseReasons: [],
            artifact,
            duplicateClusters,
            now,
            docMissing: artifact.docMissing,
          }),
          rankScore: artifact.docMissing ? 0.05 : deriveBaseRankScore(artifact, now),
          docMissing: artifact.docMissing,
        };
    return baseRow;
  });

  const deletions = input.projections
    .filter((projection) => !artifactIds.has(projection.artifactId))
    .map((projection) => projection.artifactId);

  const upserts = desired.filter((desiredRow) => {
    const current = currentById.get(desiredRow.artifactId);
    if (!current) return true;
    return projectionFingerprint(current) !== projectionFingerprint(desiredRow);
  });

  const cursor = desired.length === 0 ? "" : `${desired[desired.length - 1].publishedAt}|${desired[desired.length - 1].artifactId}`;
  return {
    desired,
    upserts,
    deletions,
    checkpoint: {
      checkpointId: "feed-projection",
      sourceKind: "artifact_index",
      artifactCursor: cursor,
      lastReconciledAt: now.toISOString(),
      status: "healthy",
    },
  };
}

export function buildFeedEvents(input: {
  projections: readonly FeedProjectionState[];
}): FeedSseEvent[] {
  const snapshotKey = hashJson(input.projections);
  return sortFeedEvents(
    input.projections.flatMap((projection) => [
      {
        id: `projection:${projection.artifactId}:${projection.updatedAt}|${snapshotKey}`,
        event: "projection-updated",
        data: {
          artifactId: projection.artifactId,
          packageId: projection.packageId,
          rankScore: projection.rankScore,
          disposition: projection.disposition,
          visibility: projection.visibility,
          reasonCodes: projection.reasonCodes,
          publishedAt: projection.publishedAt,
          updatedAt: projection.updatedAt,
        },
      },
      {
        id: `artifact:${projection.artifactId}:${projection.updatedAt}|${snapshotKey}`,
        event: "artifact-published",
        data: {
          artifactId: projection.artifactId,
          packageId: projection.packageId,
          publishedAt: projection.publishedAt,
          freshnessLabel: projection.freshnessLabel,
        },
      },
    ]),
  );
}

type FeedEventSortKey = {
  snapshotKey: string;
  updatedAt: string;
  artifactId: string;
  kindOrder: number;
};

function sortFeedEvents(events: readonly FeedSseEvent[]): FeedSseEvent[] {
  return [...events].sort((left, right) => compareFeedEventSortKeys(feedEventSortKey(left), feedEventSortKey(right)));
}

function feedEventSortKey(event: FeedSseEvent): FeedEventSortKey | null {
  return parseFeedEventId(event.id);
}

function parseFeedEventId(id: string): FeedEventSortKey | null {
  const trimmed = id.trim();
  const snapshotSeparator = trimmed.lastIndexOf("|");
  const snapshotKey = snapshotSeparator >= 0 ? trimmed.slice(snapshotSeparator + 1).trim() : "legacy";
  const base = snapshotSeparator >= 0 ? trimmed.slice(0, snapshotSeparator) : trimmed;
  const kindOrder = base.startsWith("projection:") ? 0 : base.startsWith("artifact:") ? 1 : undefined;
  if (kindOrder === undefined) return null;
  const remainder = base.slice(base.indexOf(":") + 1);
  const match = /^(.+):(\d{4}-\d{2}-\d{2}T.+)$/.exec(remainder);
  if (!match) return null;
  const artifactId = match[1];
  const updatedAt = match[2];
  if (artifactId.trim() === "" || updatedAt.trim() === "" || Number.isNaN(Date.parse(updatedAt)) || snapshotKey.trim() === "") return null;
  return { artifactId, updatedAt, kindOrder, snapshotKey };
}

function compareFeedEventSortKeys(left: FeedEventSortKey | null, right: FeedEventSortKey | null): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const updatedAt = left.updatedAt.localeCompare(right.updatedAt);
  if (updatedAt !== 0) return updatedAt;
  const artifactId = left.artifactId.localeCompare(right.artifactId);
  if (artifactId !== 0) return artifactId;
  return left.kindOrder - right.kindOrder;
}

export function renderFeedEventStream(events: readonly FeedSseEvent[]): string {
  const lines: string[] = ["retry: 5000", ""];
  for (const event of events) {
    lines.push(`id: ${event.id}`);
    lines.push(`event: ${event.event}`);
    lines.push(`data: ${stableStringify(event.data)}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function filterFeedEventsAfterId(events: readonly FeedSseEvent[], afterEventId?: string): FeedSseEvent[] {
  const ordered = sortFeedEvents(events);
  const trimmed = afterEventId?.trim();
  if (!trimmed) return ordered;
  const cursor = parseFeedEventId(trimmed);
  if (!cursor) return ordered;
  const currentSnapshotKey = feedEventSortKey(ordered[0])?.snapshotKey;
  if (!currentSnapshotKey || currentSnapshotKey !== cursor.snapshotKey) return ordered;
  return ordered.filter((event) => compareFeedEventSortKeys(feedEventSortKey(event), cursor) > 0);
}

export function buildOpenApiDocument(serverInfo: FeedHostServerInfo): Record<string, unknown> {
  const jsonResponse = {
    "application/json": {
      schema: {
        type: "object",
      },
    },
  };
  const sseResponse = {
    "text/event-stream": {
      schema: {
        type: "string",
      },
    },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Feed Host",
      version: serverInfo.versions.schema,
      description: "Feed Host API for projection, preferences, control intents, and generation requests.",
    },
    servers: [{ url: "/" }],
    paths: {
      "/health": {
        get: { responses: { 200: { description: "health", content: jsonResponse } } },
      },
      "/delegation-policy": {
        get: { responses: { 200: { description: "delegation policy", content: jsonResponse } } },
      },
      "/api/server-info": {
        get: {
          security: [],
          responses: {
            200: { description: "server info", content: jsonResponse },
            304: { description: "not modified" },
            503: { description: "unavailable" },
          },
        },
      },
      "/api/delegations": {
        post: { responses: { 200: { description: "active", content: jsonResponse }, 202: { description: "activation pending", content: jsonResponse } } },
        delete: { responses: { 204: { description: "removed" } } },
      },
      "/api/delegations/status": {
        get: { responses: { 200: { description: "delegation status", content: jsonResponse } } },
      },
      "/api/openapi.json": {
        get: { security: [], responses: { 200: { description: "openapi", content: jsonResponse } } },
      },
      "/admin/state": {
        get: { responses: { 200: { description: "state", content: jsonResponse } } },
      },
      "/admin/seed": {
        post: { responses: { 200: { description: "seeded", content: jsonResponse } } },
      },
      "/feed": {
        get: { responses: { 200: { description: "feed", content: jsonResponse } } },
      },
      "/feed/events": {
        get: {
          parameters: [
            {
              name: "Last-Event-ID",
              in: "header",
              required: false,
              schema: { type: "string" },
            },
          ],
          responses: { 200: { description: "sse", content: sseResponse } },
        },
      },
      "/artifacts/{artifactId}": {
        get: { responses: { 200: { description: "artifact", content: jsonResponse } } },
      },
      "/artifacts/{artifactId}/provenance": {
        get: { responses: { 200: { description: "provenance", content: jsonResponse } } },
      },
      "/feedback": {
        post: { responses: { 200: { description: "applied", content: jsonResponse } } },
      },
      "/control-intents": {
        get: { responses: { 200: { description: "control intents", content: jsonResponse } } },
        post: { responses: { 200: { description: "applied", content: jsonResponse }, 202: { description: "accepted", content: jsonResponse } } },
      },
      "/preferences": {
        get: { responses: { 200: { description: "preferences", content: jsonResponse } } },
        put: { responses: { 200: { description: "updated", content: jsonResponse }, 409: { description: "version conflict", content: jsonResponse } } },
      },
      "/generation-requests": {
        get: { responses: { 200: { description: "generation requests", content: jsonResponse } } },
      },
    },
  };
}

export function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      return JSON.stringify(value.toString());
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map((entry) => stringify(entry)).join(",")}]`;
      }
      return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stringify(entry)}`)
        .join(",")}}`;
    default:
      return JSON.stringify(String(value));
  }
}

export function sanitizePreferenceValue(value: FeedPreferenceValue): FeedPreferenceValue {
  const sanitized: FeedPreferenceValue = {};
  if (value.packagePriority) sanitized.packagePriority = stringNumberMap(value.packagePriority);
  if (value.typePriority) sanitized.typePriority = stringNumberMap(value.typePriority);
  if (value.sourcePriority) sanitized.sourcePriority = stringNumberMap(value.sourcePriority);
  if (value.savedArtifactIds) sanitized.savedArtifactIds = uniqueStrings(value.savedArtifactIds);
  if (value.hiddenArtifactIds) sanitized.hiddenArtifactIds = uniqueStrings(value.hiddenArtifactIds);
  if (value.packageDisabled) sanitized.packageDisabled = uniqueStrings(value.packageDisabled);
  if (value.typeSuppressed) sanitized.typeSuppressed = uniqueStrings(value.typeSuppressed);
  if (value.showFewerPackageIds) sanitized.showFewerPackageIds = stringNumberMap(value.showFewerPackageIds);
  if (Number.isFinite(value.cooldownMinutes ?? NaN)) sanitized.cooldownMinutes = Number(value.cooldownMinutes);
  if (Number.isFinite(value.diversityWindow ?? NaN)) sanitized.diversityWindow = Number(value.diversityWindow);
  if (Number.isFinite(value.priority ?? NaN)) sanitized.priority = Number(value.priority);
  if (typeof value.paused === "boolean") sanitized.paused = value.paused;
  if (typeof value.disabled === "boolean") sanitized.disabled = value.disabled;
  if (value.cadence === "more" || value.cadence === "normal" || value.cadence === "less") sanitized.cadence = value.cadence;
  return sanitized;
}

function mergePreferenceValue(base: FeedPreferenceValue, patch: FeedPreferenceValue): void {
  const sanitized = sanitizePreferenceValue(patch);
  if (sanitized.packagePriority) base.packagePriority = { ...(base.packagePriority ?? {}), ...sanitized.packagePriority };
  if (sanitized.typePriority) base.typePriority = { ...(base.typePriority ?? {}), ...sanitized.typePriority };
  if (sanitized.sourcePriority) base.sourcePriority = { ...(base.sourcePriority ?? {}), ...sanitized.sourcePriority };
  if (sanitized.savedArtifactIds) base.savedArtifactIds = uniqueStrings([...(base.savedArtifactIds ?? []), ...sanitized.savedArtifactIds]);
  if (sanitized.hiddenArtifactIds) base.hiddenArtifactIds = uniqueStrings([...(base.hiddenArtifactIds ?? []), ...sanitized.hiddenArtifactIds]);
  if (sanitized.packageDisabled) base.packageDisabled = uniqueStrings([...(base.packageDisabled ?? []), ...sanitized.packageDisabled]);
  if (sanitized.typeSuppressed) base.typeSuppressed = uniqueStrings([...(base.typeSuppressed ?? []), ...sanitized.typeSuppressed]);
  if (sanitized.showFewerPackageIds) {
    base.showFewerPackageIds = { ...(base.showFewerPackageIds ?? {}), ...sanitized.showFewerPackageIds };
  }
  if (sanitized.cooldownMinutes !== undefined) base.cooldownMinutes = sanitized.cooldownMinutes;
  if (sanitized.diversityWindow !== undefined) base.diversityWindow = sanitized.diversityWindow;
  if (sanitized.priority !== undefined) base.priority = sanitized.priority;
  if (sanitized.paused !== undefined) base.paused = sanitized.paused;
  if (sanitized.disabled !== undefined) base.disabled = sanitized.disabled;
  if (sanitized.cadence !== undefined) base.cadence = sanitized.cadence;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim() !== "").map((value) => value.trim()))];
}

function stringNumberMap(value: Record<string, number>): Record<string, number> {
  const entries = Object.entries(value)
    .filter(([, entry]) => Number.isFinite(entry))
    .map(([key, entry]) => [key, Number(entry)] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

function scoreRank(
  item: FeedProjectionState,
  preferences: FeedPreferenceAggregate,
  feedbackByArtifact: Map<string, FeedFeedbackSummary>,
  clusters: Map<string, FeedProjectionState[]>,
  now: Date,
): FeedProjectionState {
  const reasons = [...item.reasonCodes];
  let score = Number.isFinite(item.rankScore) ? item.rankScore : 0;
  const ageHours = Math.max(0, (now.getTime() - Date.parse(item.publishedAt)) / 3_600_000);
  const recencyBoost = clampScore(Math.max(0, 0.2 - ageHours / 1680));
  if (recencyBoost > 0) reasons.push("recent");
  score += recencyBoost;

  const presentation = preferences.presentation;
  const packageScopes = preferences.packageScopes;
  const packageScope = packageScopes.get(`package:${item.packageId}`);
  const packagePriority = presentation.packagePriority?.[item.packageId] ?? 0;
  if (packagePriority !== 0) reasons.push("package_priority");
  score += packagePriority * 0.12;

  const typePriority = presentation.typePriority?.[item.artifactType] ?? 0;
  score += typePriority * 0.08;
  if (typePriority < 0) reasons.push("type_suppressed");

  const sourcePriority = presentation.sourcePriority?.[item.sourceFingerprint] ?? 0;
  score += sourcePriority * 0.08;

  if ((presentation.savedArtifactIds ?? []).includes(item.artifactId) || item.disposition === "saved") {
    score += 0.4;
    reasons.push("saved");
  }

  if ((presentation.hiddenArtifactIds ?? []).includes(item.artifactId) || item.disposition === "hidden") {
    score -= 0.7;
    reasons.push("hidden");
  }

  if ((presentation.packageDisabled ?? []).includes(item.packageId) || packageScope?.paused === true || packageScope?.disabled === true) {
    score -= 0.8;
    reasons.push("package_disabled");
  }

  const packageCadence = packageScope?.cadence ?? presentation.cadence;
  const showFewerCount =
    (presentation.showFewerPackageIds ?? {})[item.packageId] ?? (packageScope?.showFewerPackageIds ?? {})[item.packageId] ?? 0;
  if (showFewerCount > 0 || packageCadence === "less") {
    score -= 0.18 * Math.max(1, showFewerCount || 1);
    reasons.push("cooldown");
    reasons.push("less_like_this");
  }
  if (packageCadence === "more") {
    score += 0.12;
  }

  const feedback = feedbackByArtifact.get(item.artifactId);
  if (feedback) {
    if (feedback.saved > 0) {
      score += Math.min(0.2, 0.08 * feedback.saved);
      reasons.push("saved");
    }
    if (feedback.hidden > 0) {
      score -= Math.min(0.4, 0.1 * feedback.hidden);
      reasons.push("hidden");
    }
    if (feedback.helpful > feedback.unhelpful) {
      score += Math.min(0.25, 0.08 * (feedback.helpful - feedback.unhelpful));
      reasons.push("helpful_signal");
    }
    if (feedback.unhelpful > feedback.helpful) {
      score -= Math.min(0.35, 0.08 * (feedback.unhelpful - feedback.helpful));
      reasons.push("less_like_this");
    }
    if (feedback.showFewer > 0) {
      score -= Math.min(0.4, 0.12 * feedback.showFewer);
      reasons.push("cooldown");
    }
  }

  if (item.docMissing) {
    score -= 1.5;
    reasons.push("broken_ref");
    reasons.push("source_unavailable");
  }

  const cluster = clusters.get(item.sourceFingerprint) ?? [];
  if (cluster.length > 1) {
    const earliest = [...cluster].sort(comparePublishedThenId)[0];
    if (earliest && earliest.artifactId !== item.artifactId) {
      score -= 0.12;
      reasons.push("duplicate_cluster");
    }
  }

  if (item.freshnessLabel === "source_unavailable" || item.freshnessLabel === "source_revoked") {
    reasons.push(item.freshnessLabel);
  }

  return {
    ...item,
    rankScore: clampScore(score),
    reasonCodes: uniqueReasons(reasons),
  };
}

function compareRanked(left: FeedProjectionState, right: FeedProjectionState): number {
  const score = right.rankScore - left.rankScore;
  if (score !== 0) return score;
  return comparePublishedThenId(left, right);
}

function comparePublishedThenId(left: FeedProjectionState, right: FeedProjectionState): number {
  const published = right.publishedAt.localeCompare(left.publishedAt);
  if (published !== 0) return published;
  return left.artifactId.localeCompare(right.artifactId);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function sourceFingerprintClusters<T extends { artifactId: string; sourceFingerprint: string }>(
  items: readonly T[],
): Map<string, T[]> {
  const clusters = new Map<string, T[]>();
  for (const item of items) {
    const group = clusters.get(item.sourceFingerprint) ?? [];
    group.push(item);
    clusters.set(item.sourceFingerprint, group);
  }
  return clusters;
}

function deriveBaseRankScore(artifact: FeedReconcileArtifact, now: Date): number {
  const ageHours = Math.max(0, (now.getTime() - Date.parse(artifact.publishedAt)) / 3_600_000);
  const recency = Math.max(0, 0.22 - ageHours / 1_680);
  const freshnessBias =
    artifact.freshnessLabel === "fresh"
      ? 0.08
      : artifact.freshnessLabel === "as_of"
        ? 0.05
        : artifact.freshnessLabel === "stale"
          ? -0.05
          : -0.12;
  return clampScore(0.55 + recency + freshnessBias);
}

function canonicalReasonCodes(input: {
  baseReasons: readonly string[];
  artifact: FeedReconcileArtifact;
  duplicateClusters: Map<string, FeedReconcileArtifact[]>;
  now: Date;
  docMissing: boolean;
}): string[] {
  const reasons = input.docMissing
    ? [...input.baseReasons]
    : input.baseReasons.filter((reason) => reason !== "broken_ref" && reason !== "source_unavailable");
  const ageHours = Math.max(0, (input.now.getTime() - Date.parse(input.artifact.publishedAt)) / 3_600_000);
  if (ageHours <= 168) reasons.push("recent");
  if (input.docMissing) {
    reasons.push("broken_ref");
    reasons.push("source_unavailable");
  }
  const cluster = input.duplicateClusters.get(input.artifact.sourceFingerprint) ?? [];
  if (cluster.length > 1) {
    const earliest = [...cluster].sort((left, right) => {
      const published = left.publishedAt.localeCompare(right.publishedAt);
      if (published !== 0) return published;
      return left.artifactId.localeCompare(right.artifactId);
    })[0];
    if (earliest && earliest.artifactId !== input.artifact.artifactId) reasons.push("duplicate_cluster");
  }
  return uniqueReasons(reasons);
}

function projectionFingerprint(value: FeedProjectionState): string {
  return hashJson({
    artifactId: value.artifactId,
    artifactType: value.artifactType,
    packageId: value.packageId,
    sourceFingerprint: value.sourceFingerprint,
    publishedAt: value.publishedAt,
    updatedAt: value.updatedAt,
    freshnessLabel: value.freshnessLabel,
    disposition: value.disposition,
    visibility: value.visibility,
    reasonCodes: [...value.reasonCodes].sort(),
    rankScore: value.rankScore,
    docMissing: value.docMissing,
  });
}

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons.filter((reason) => reason.trim() !== ""))];
}
