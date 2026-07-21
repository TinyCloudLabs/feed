import {
  deserializeDelegation,
  principalDid,
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
// Artifact media (hero images now; audio/video later) lives under its own
// prefix, sibling to the artifact docs. Read-only from the host.
export const FEED_HOST_ARTIFACT_MEDIA_PREFIX = "xyz.tinycloud.artifacts/media/";

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
    service: "tinycloud.kv",
    serviceShort: "kv",
    path: FEED_HOST_ARTIFACT_MEDIA_PREFIX,
    actions: ["tinycloud.kv/get"],
  },
  {
    service: "tinycloud.sql",
    serviceShort: "sql",
    path: "xyz.tinycloud.listen/conversations",
    actions: ["tinycloud.sql/read"],
  },
  {
    service: "tinycloud.kv",
    serviceShort: "kv",
    path: "xyz.tinycloud.listen/transcript/",
    actions: ["tinycloud.kv/get", "tinycloud.kv/list"],
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
  host?: string;
  parentCid?: string;
  isRevoked?: boolean;
  cid?: string;
  allowSubDelegation?: boolean;
  disableSubDelegation?: boolean;
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
    // The node SDK reports its DID as a DID URL with a verification-method
    // fragment (did:key:z6Mk...#z6Mk...). UCAN audiences must be the bare
    // principal DID — the capability-chain signer rejects fragments.
    delegateDID: principalDid(delegateDID),
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
    // Content-bearing Listen reads must never enter an SDK telemetry sink.
    telemetry: false,
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

export function validateInputAuthorityDelegation(input: {
  serializedDelegation: string;
  expectedDelegateDID: string;
  expectedHost: string;
  computeDelegationCid: (authorization: string) => string;
  now?: Date;
}): {
  portableDelegation: PortableDelegation;
  canonicalPortableDelegation: string;
  childCid: string;
  actorId: string;
  audienceDID: string;
  host: string;
  space: string;
  path: string;
  actions: string[];
  expiry: string;
  parentCid: string;
  agentDID: string;
  revoked: boolean;
} {
  const inspectedAt = input.now ?? new Date();
  let delegation: DelegationLike;
  try {
    delegation = deserializeDelegation(input.serializedDelegation) as DelegationLike;
  } catch {
    throw new FeedDelegationError("input authority could not be deserialized", "malformed");
  }
  const payload = decodeJwtPayload(delegation.delegationHeader?.Authorization ?? "");
  const audienceDID = typeof payload.aud === "string" ? principalDid(payload.aud) : "";
  if (
    !delegation.delegateDID ||
    !principalDidEquals(delegation.delegateDID, input.expectedDelegateDID) ||
    !principalDidEquals(audienceDID, input.expectedDelegateDID)
  ) {
    throw new FeedDelegationError("input authority audience does not match Feed Host DID", "wrong_delegatee");
  }
  const signedExpiry = typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  if (!signedExpiry || Number.isNaN(signedExpiry.getTime())) {
    throw new FeedDelegationError("input authority signed expiry is invalid", "malformed");
  }
  if (signedExpiry <= inspectedAt) throw new FeedDelegationError("input authority is expired", "expired");
  const grants = signedGrantsFromDelegation(delegation);
  if (grants.length !== 1) throw new FeedDelegationError("input authority must grant one transcript resource", "insufficient_policy");
  const grant = grants[0]!;
  const actorId = signedOwnerDid(grants);
  if (!actorId) throw new FeedDelegationError("input authority carries no signed owner space", "actor_mismatch");
  const proofs = payload.prf;
  if (!Array.isArray(proofs) || proofs.length !== 1 || !isCanonicalDelegationCid(proofs[0])) {
    throw new FeedDelegationError("input authority must carry exactly one canonical parent proof", "malformed");
  }
  if (!isCanonicalDelegationCid(delegation.parentCid) || proofs[0] !== delegation.parentCid) {
    throw new FeedDelegationError("input authority parent lineage does not match signed proof", "malformed");
  }
  if (!isCanonicalDelegationCid(delegation.cid) || delegation.disableSubDelegation !== true || delegation.allowSubDelegation !== false) {
    throw new FeedDelegationError("input authority is not a terminal child delegation", "malformed");
  }
  const host = typeof delegation.host === "string" ? delegation.host : "";
  if (normalizeOrigin(host) !== normalizeOrigin(input.expectedHost)) {
    throw new FeedDelegationError("input authority host is not allowlisted", "insufficient_policy");
  }
  const issuerDID = typeof payload.iss === "string" ? principalDid(payload.iss) : "";
  if (!issuerDID) throw new FeedDelegationError("input authority signed issuer is missing", "malformed");
  const owner = ownerFromActorId(actorId);
  if (!owner) throw new FeedDelegationError("input authority owner is malformed", "actor_mismatch");
  const authorization = delegation.delegationHeader?.Authorization;
  if (!authorization) throw new FeedDelegationError("input authority authorization is missing", "malformed");
  let computedCid: string;
  try {
    computedCid = input.computeDelegationCid(authorization);
  } catch {
    throw new FeedDelegationError("input authority CID could not be computed", "malformed");
  }
  if (computedCid !== delegation.cid) {
    throw new FeedDelegationError("input authority CID does not match its authorization", "malformed");
  }
  const canonicalPortableDelegation = JSON.stringify({
    cid: delegation.cid,
    delegateDID: audienceDID,
    delegatorDID: issuerDID,
    spaceId: grant.space,
    path: grant.path,
    actions: [...grant.actions],
    expiry: signedExpiry.toISOString(),
    isRevoked: false,
    allowSubDelegation: false,
    parentCid: proofs[0],
    createdAt: inspectedAt.toISOString(),
    delegationHeader: { Authorization: authorization },
    ownerAddress: owner.address,
    chainId: owner.chainId,
    host: normalizeOrigin(input.expectedHost),
    resources: [{ service: grant.service, space: grant.space, path: grant.path, actions: [...grant.actions] }],
    disableSubDelegation: true,
  });
  return {
    portableDelegation: delegation,
    canonicalPortableDelegation,
    childCid: delegation.cid,
    actorId,
    audienceDID,
    host,
    space: grant.space,
    path: grant.path,
    actions: [...grant.actions],
    expiry: signedExpiry.toISOString(),
    parentCid: proofs[0],
    agentDID: principalDid(input.expectedDelegateDID),
    revoked: delegation.isRevoked === true,
  };
}

export function isCanonicalDelegationCid(value: unknown): value is string {
  if (typeof value !== "string" || !/^b[a-z2-7]{58}$/.test(value)) return false;
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value.slice(1)) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return false;
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return bits === 2 && buffer === 0 && bytes.length === 36 &&
    bytes[0] === 0x01 && bytes[1] === 0x55 && bytes[2] === 0x1e && bytes[3] === 0x20;
}

function ownerFromActorId(actorId: string): { chainId: number; address: string } | null {
  const match = actorId.match(/^did:pkh:eip155:(\d+):(0x[a-fA-F0-9]{40})$/);
  if (!match) return null;
  const chainId = Number(match[1]);
  return Number.isSafeInteger(chainId) ? { chainId, address: match[2]! } : null;
}

export function hasCompleteFeedHostDelegation<T extends AcceptedFeedDelegation>(
  accepted: T | undefined,
): accepted is T {
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

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return "invalid-origin";
  }
}
