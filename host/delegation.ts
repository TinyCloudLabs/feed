import {
  deserializeDelegation,
  principalDidEquals,
  TinyCloudNode,
  type DelegatedAccess,
  type Manifest,
  type PortableDelegation,
} from "@tinycloud/node-sdk";
import {
  FEED_V1_ARTIFACT_DOC_PREFIX,
  FEED_V1_ARTIFACTS_INDEX_DB_PATH,
  FEED_V1_FEED_INDEX_DB_PATH,
} from "../../artifactory/skills/_shared/lib/feed-v1-schema.ts";
import {
  LEGACY_FEED_DB_PATH,
  LEGACY_INTERACTIONS_DB_PATH,
} from "../../artifactory/skills/_shared/lib/feed-v1-migration.ts";

export const FEED_HOST_SQL_ACTIONS = [
  "tinycloud.sql/read",
  "tinycloud.sql/write",
  "tinycloud.sql/schema",
] as const;

export const FEED_HOST_KV_ACTIONS = [
  "tinycloud.kv/get",
  "tinycloud.kv/put",
  "tinycloud.kv/list",
] as const;

// Canonical spec split: Artifacts SQL/KV live under xyz.tinycloud.artifacts,
// Feed SQL under xyz.tinycloud.feed. Sourced from the Artifactory shared
// contracts so the delegation policy and minted delegations stay in lockstep.
export const FEED_HOST_ARTIFACTS_DB_PATH = FEED_V1_ARTIFACTS_INDEX_DB_PATH;
export const FEED_HOST_FEED_DB_PATH = FEED_V1_FEED_INDEX_DB_PATH;
export const FEED_HOST_FEED_SETTINGS_PREFIX = "xyz.tinycloud.feed/settings";
export const FEED_HOST_ARTIFACT_DOC_PREFIX = FEED_V1_ARTIFACT_DOC_PREFIX;

export const FEED_HOST_DELEGATION_RESOURCES = [
  {
    service: "tinycloud.sql",
    serviceShort: "sql",
    path: FEED_HOST_ARTIFACTS_DB_PATH,
    actions: [...FEED_HOST_SQL_ACTIONS],
  },
  {
    service: "tinycloud.sql",
    serviceShort: "sql",
    path: FEED_HOST_FEED_DB_PATH,
    actions: [...FEED_HOST_SQL_ACTIONS],
  },
  {
    service: "tinycloud.kv",
    serviceShort: "kv",
    path: FEED_HOST_FEED_SETTINGS_PREFIX,
    actions: [...FEED_HOST_KV_ACTIONS],
  },
  {
    service: "tinycloud.kv",
    serviceShort: "kv",
    path: FEED_HOST_ARTIFACT_DOC_PREFIX,
    actions: [...FEED_HOST_KV_ACTIONS],
  },
  {
    service: "tinycloud.sql",
    serviceShort: "sql",
    path: LEGACY_FEED_DB_PATH,
    actions: ["tinycloud.sql/read"],
  },
  {
    service: "tinycloud.sql",
    serviceShort: "sql",
    path: LEGACY_INTERACTIONS_DB_PATH,
    actions: ["tinycloud.sql/read"],
  },
] as const;

export type FeedHostDelegationPolicy = {
  delegateDID: string;
  resources: typeof FEED_HOST_DELEGATION_RESOURCES;
};

export type AcceptedFeedDelegation = {
  actorId: string;
  acceptedAt: string;
  resources: string[];
};

export type ActivatedFeedDelegation = AcceptedFeedDelegation & {
  expiresAt: string;
  portableDelegation: PortableDelegation;
  access: DelegatedAccess;
};

type SignedGrant = {
  space: string;
  service: string;
  path: string;
  actions: string[];
};

type DelegationLike = PortableDelegation & {
  delegationHeader?: { Authorization?: string };
  expiry?: string | Date;
  path?: string;
  actions?: string[];
};

export class FeedDelegationError extends Error {
  constructor(
    message: string,
    readonly code: "malformed" | "wrong_delegatee" | "expired" | "insufficient_policy" | "actor_mismatch" | "delegation_stale",
  ) {
    super(message);
    this.name = "FeedDelegationError";
  }
}

// Actor ids are did:pkh identities whose embedded eip155 address is
// case-insensitive, so all map/store keys use the normalized form.
export function normalizeActorId(actorId: string): string {
  return actorId.toLowerCase();
}

export function actorIdsMatch(a: string, b: string): boolean {
  return normalizeActorId(a) === normalizeActorId(b);
}

export function createFeedHostPolicy(delegateDID: string): FeedHostDelegationPolicy {
  return {
    delegateDID,
    resources: FEED_HOST_DELEGATION_RESOURCES,
  };
}

const FEED_HOST_SPACE_PREFIX = "feed-host";

function feedHostNodeManifest(spaceName: string): Manifest {
  return {
    manifest_version: 1,
    app_id: "xyz.tinycloud.feed.host",
    name: "Feed Host",
    defaults: false,
    permissions: [
      {
        service: "tinycloud.kv",
        space: spaceName,
        path: "delegations/",
        actions: ["get", "put", "del", "list", "metadata"],
        skipPrefix: true,
      },
    ],
  };
}

export function createFeedHostNode(input: { privateKey?: string; host?: string }): TinyCloudNode {
  return new TinyCloudNode({
    ...(input.privateKey ? { privateKey: input.privateKey } : {}),
    ...(input.host ? { host: input.host } : {}),
    prefix: FEED_HOST_SPACE_PREFIX,
    autoCreateSpace: true,
    enablePublicSpace: false,
    includeAccountRegistryPermissions: false,
    manifest: feedHostNodeManifest(FEED_HOST_SPACE_PREFIX),
  });
}

export function validateFeedHostDelegation(input: {
  serializedDelegation: string;
  expectedDelegateDID: string;
  now?: Date;
}): AcceptedFeedDelegation & { expiresAt: string; portableDelegation: PortableDelegation } {
  let delegation: DelegationLike;
  try {
    delegation = deserializeDelegation(input.serializedDelegation) as DelegationLike;
  } catch {
    throw new FeedDelegationError("delegation could not be deserialized", "malformed");
  }

  if (!delegation.delegateDID || !principalDidEquals(delegation.delegateDID, input.expectedDelegateDID)) {
    throw new FeedDelegationError("delegation delegateDID does not match Feed Host DID", "wrong_delegatee");
  }

  const expiry = parseExpiry(delegation.expiry);
  if (!expiry) throw new FeedDelegationError("delegation expiry is missing or invalid", "malformed");
  if (expiry <= (input.now ?? new Date())) throw new FeedDelegationError("delegation is expired", "expired");

  const grants = signedGrantsFromDelegation(delegation);
  const acceptedResources: string[] = [];
  for (const resource of FEED_HOST_DELEGATION_RESOURCES) {
    const grant = grants.find((candidate) => serviceMatches(candidate.service, resource) && candidate.path === resource.path);
    if (!grant) continue;
    const granted = new Set(grant.actions);
    const missing = resource.actions.filter((action) => !granted.has(action));
    if (missing.length > 0) {
      throw new FeedDelegationError(`delegation is missing required actions for ${resource.path}`, "insufficient_policy");
    }
    acceptedResources.push(resource.path);
  }

  if (acceptedResources.length === 0) {
    throw new FeedDelegationError("delegation is missing a required Feed Host resource", "insufficient_policy");
  }

  // The actor identity is derived from the signed delegation itself — never
  // from caller-supplied request fields — so a delegation can only bind to
  // the namespace of the owner who actually minted it.
  const actorId = signedOwnerDid(grants) ?? ownerDidFromDelegation(delegation);
  if (!actorId) {
    throw new FeedDelegationError("delegation carries no owner identity to bind an actor", "malformed");
  }

  return {
    actorId,
    acceptedAt: new Date().toISOString(),
    expiresAt: expiry.toISOString(),
    resources: acceptedResources,
    portableDelegation: delegation,
  };
}

export async function activateFeedHostDelegation(input: {
  node: TinyCloudNode;
  serializedDelegation: string;
  expectedDelegateDID: string;
}): Promise<ActivatedFeedDelegation> {
  const accepted = validateFeedHostDelegation({
    serializedDelegation: input.serializedDelegation,
    expectedDelegateDID: input.expectedDelegateDID,
  });
  const access = await input.node.useDelegation(accepted.portableDelegation);
  return { ...accepted, access };
}

export function hasCompleteFeedHostDelegation(accepted: AcceptedFeedDelegation | undefined): boolean {
  if (!accepted) return false;
  const granted = new Set(accepted.resources);
  return FEED_HOST_DELEGATION_RESOURCES.every((resource) => granted.has(resource.path));
}

function signedGrantsFromDelegation(delegation: DelegationLike): SignedGrant[] {
  const auth = delegation.delegationHeader?.Authorization;
  if (!auth || typeof auth !== "string") {
    throw new FeedDelegationError("delegation has no signed Authorization capability", "malformed");
  }
  if (!auth.replace(/^Bearer\s+/i, "").includes(".")) {
    return topLevelGrantsFromSdkDelegation(delegation);
  }
  const payload = decodeJwtPayload(auth);
  const att = payload.att;
  if (!att || typeof att !== "object" || Array.isArray(att)) {
    throw new FeedDelegationError("delegation signed capability has no att claim", "malformed");
  }

  const grants: SignedGrant[] = [];
  for (const [uri, abilities] of Object.entries(att as Record<string, unknown>)) {
    if (!abilities || typeof abilities !== "object" || Array.isArray(abilities)) continue;
    const parsed = parseAttResourceUri(uri);
    if (!parsed) continue;
    grants.push({ ...parsed, actions: Object.keys(abilities as Record<string, unknown>) });
  }
  if (grants.length === 0) throw new FeedDelegationError("delegation signed capability grants no resources", "malformed");
  return grants;
}

function topLevelGrantsFromSdkDelegation(delegation: DelegationLike): SignedGrant[] {
  if (!delegation.path || !Array.isArray(delegation.actions) || delegation.actions.length === 0) {
    throw new FeedDelegationError("SDK delegation is missing path/actions summary", "malformed");
  }
  const space = typeof delegation.spaceId === "string" ? delegation.spaceId : "";
  return [
    {
      space,
      service: serviceForActions(delegation.actions),
      path: delegation.path,
      actions: delegation.actions,
    },
  ];
}

function decodeJwtPayload(authHeader: string): Record<string, unknown> {
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const parts = jwt.split(".");
  if (parts.length < 2) throw new FeedDelegationError("delegation Authorization is not a signed capability JWT", "malformed");
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("payload is not an object");
    }
    return payload as Record<string, unknown>;
  } catch {
    throw new FeedDelegationError("delegation Authorization payload is invalid", "malformed");
  }
}

function parseAttResourceUri(uri: string): Omit<SignedGrant, "actions"> | null {
  const parts = uri.split("/");
  if (parts.length < 3) return null;
  const space = parts[0];
  const service = parts[1];
  const path = parts.slice(2).join("/");
  return { space, service, path };
}

function parseExpiry(value: unknown): Date | null {
  const expiry = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(expiry.getTime()) ? null : expiry;
}

function serviceMatches(service: string, resource: (typeof FEED_HOST_DELEGATION_RESOURCES)[number]): boolean {
  return service === resource.service || service === resource.serviceShort;
}

function serviceForActions(actions: string[]): string {
  if (actions.every((action) => action.startsWith("tinycloud.kv/"))) return "tinycloud.kv";
  if (actions.every((action) => action.startsWith("tinycloud.sql/"))) return "tinycloud.sql";
  throw new FeedDelegationError("SDK delegation has mixed or unknown action services", "malformed");
}

function signedOwnerDid(grants: SignedGrant[]): string | null {
  for (const grant of grants) {
    const match = grant.space.match(/^tinycloud:pkh:(eip155:\d+:0x[a-fA-F0-9]{40}):/);
    if (match) return `did:pkh:${match[1]}`;
  }
  return null;
}

function ownerDidFromDelegation(delegation: DelegationLike): string | null {
  if (typeof delegation.ownerAddress !== "string" || !/^0x[a-fA-F0-9]{40}$/.test(delegation.ownerAddress)) {
    return null;
  }
  if (typeof delegation.chainId !== "number" || !Number.isInteger(delegation.chainId)) return null;
  return `did:pkh:eip155:${delegation.chainId}:${delegation.ownerAddress}`;
}
