import {
  BrowserSessionStorage,
  serializeDelegation,
  TinyCloudWeb,
  type Config,
  type Delegation,
  type Manifest,
  type PortableDelegation,
} from "@tinycloud/web-sdk";
import type { providers } from "ethers";
import { DEFAULT_REVIEWED_BUNDLE } from "../../shared/default-reviewed-bundle.ts";
import { TINYCLOUD_HOST } from "./config.ts";
import type { FeedHostDelegationPolicy, FeedHostDelegationReceipt } from "./delegation.ts";
import { FeedV1HostClient } from "./feedV1HostClient.ts";
import { connectWallet } from "./openkey.ts";
import { firstRunApprovalKey } from "./firstRunConsent.ts";

const SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_ADDRESS_KEY = "feed:v1:lastAddress";
const DELEGATION_CACHE_KEY = "feed:v1:hostDelegations";
// First-run consent is durable TinyCloud state, not browser-local storage.

const MANIFEST: Manifest = {
  app_id: "xyz.tinycloud.feed",
  name: "TinyFeed",
  description: "Private Feed Host client for Feed v1 artifacts and controls.",
  space: "applications",
  prefix: "",
  defaults: false,
  permissions: [
    {
      service: "tinycloud.kv",
      space: "applications",
      path: "feed:v1:first-run-approval/",
      actions: ["get", "put"],
      description: "Store first-run approval records for the default reviewed bundle.",
    },
  ],
};

let instance: TinyCloudWeb | null = null;
let walletMode = false;

export type FeedSession = {
  address: string;
  readerDid: string;
};

export type FirstRunApprovalRecord = {
  schemaVersion: "feed.v1.first_run_approval";
  actorId: string;
  hostOrigin: string;
  bundleId: string;
  bundleDigest: string;
  approvedAt: string;
  disclosure: {
    userCopy: string;
    credentialOwner: typeof DEFAULT_REVIEWED_BUNDLE.disclosure.credentialOwner;
    providerClass: typeof DEFAULT_REVIEWED_BUNDLE.disclosure.providerClass;
    egressClass: typeof DEFAULT_REVIEWED_BUNDLE.disclosure.egressClass;
  };
};

type CachedFeedHostDelegation = {
  actorId: string;
  delegateDID: string;
  resources: Array<{
    path: string;
    actions: string[];
    serializedDelegation: string;
  }>;
};

export async function loadFirstRunApproval(input: { actorId: string; hostOrigin: string }): Promise<FirstRunApprovalRecord | null> {
  if (!instance) return null;
  try {
    const result = await instance.kv.get<FirstRunApprovalRecord>(firstRunApprovalKey(input.hostOrigin));
    if (!result.ok) return null;
    const record = result.data.data;
    if (!isFirstRunApprovalRecord(record, input.actorId, input.hostOrigin)) return null;
    return record;
  } catch {
    return null;
  }
}

export async function saveFirstRunApproval(input: {
  actorId: string;
  hostOrigin: string;
  approvedAt?: string;
}): Promise<FirstRunApprovalRecord> {
  if (!instance) throw new Error("TinyCloud session is required before recording first-run approval");
  const record: FirstRunApprovalRecord = {
    schemaVersion: "feed.v1.first_run_approval",
    actorId: input.actorId,
    hostOrigin: input.hostOrigin,
    bundleId: DEFAULT_REVIEWED_BUNDLE.packageId,
    bundleDigest: DEFAULT_REVIEWED_BUNDLE.digest,
    approvedAt: input.approvedAt ?? new Date().toISOString(),
    disclosure: {
      userCopy: DEFAULT_REVIEWED_BUNDLE.disclosure.userCopy,
      credentialOwner: DEFAULT_REVIEWED_BUNDLE.disclosure.credentialOwner,
      providerClass: DEFAULT_REVIEWED_BUNDLE.disclosure.providerClass,
      egressClass: DEFAULT_REVIEWED_BUNDLE.disclosure.egressClass,
    },
  };
  const result = await instance.kv.put(firstRunApprovalKey(input.hostOrigin), record);
  if (!result.ok) throw new Error(result.error.message);
  return record;
}

function delegationManifest(policy: FeedHostDelegationPolicy): Manifest {
  return {
    app_id: "xyz.tinycloud.feed.host",
    name: "TinyFeed Host",
    description: "Delegated Feed Host access to Feed v1 resources.",
    did: policy.delegateDID,
    space: "applications",
    prefix: "",
    defaults: false,
    permissions: policy.resources.map((resource) => ({
      service: resource.service,
      path: resource.path,
      actions: resource.actions,
      skipPrefix: true,
      description: "Allow Feed Host to read/write Feed v1 resources for this user.",
    })),
  };
}

function isFirstRunApprovalRecord(value: unknown, actorId: string, hostOrigin: string): value is FirstRunApprovalRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<FirstRunApprovalRecord>;
  return (
    record.schemaVersion === "feed.v1.first_run_approval" &&
    record.actorId === actorId &&
    record.hostOrigin === hostOrigin &&
    record.bundleId === DEFAULT_REVIEWED_BUNDLE.packageId &&
    record.bundleDigest === DEFAULT_REVIEWED_BUNDLE.digest &&
    typeof record.approvedAt === "string" &&
    !!record.disclosure &&
    typeof record.disclosure === "object" &&
    !Array.isArray(record.disclosure) &&
    record.disclosure.userCopy === DEFAULT_REVIEWED_BUNDLE.disclosure.userCopy &&
    record.disclosure.credentialOwner === DEFAULT_REVIEWED_BUNDLE.disclosure.credentialOwner &&
    record.disclosure.providerClass === DEFAULT_REVIEWED_BUNDLE.disclosure.providerClass &&
    record.disclosure.egressClass === DEFAULT_REVIEWED_BUNDLE.disclosure.egressClass
  );
}

function buildConfig(web3Provider?: providers.Web3Provider, policy?: FeedHostDelegationPolicy): Config {
  return {
    ...(web3Provider ? { providers: { web3: { driver: web3Provider } } } : {}),
    tinycloudHosts: [TINYCLOUD_HOST],
    manifest: policy ? [MANIFEST, delegationManifest(policy)] : MANIFEST,
    sessionStorage: new BrowserSessionStorage(),
    sessionExpirationMs: SESSION_EXPIRATION_MS,
  };
}

function savedAddress(): string | null {
  try {
    return localStorage.getItem(LAST_ADDRESS_KEY);
  } catch {
    return null;
  }
}

export async function signIn(policy: FeedHostDelegationPolicy): Promise<FeedSession> {
  const { address, web3Provider } = await connectWallet();
  const tc = new TinyCloudWeb(buildConfig(web3Provider, policy));
  await tc.signIn();
  instance = tc;
  walletMode = true;
  try {
    localStorage.setItem(LAST_ADDRESS_KEY, address);
  } catch {
    // Restore is best-effort; sign-in still succeeded.
  }
  return { address, readerDid: tc.did };
}

export async function restoreSession(policy?: FeedHostDelegationPolicy): Promise<FeedSession | null> {
  const address = savedAddress();
  if (!address) return null;
  const tc = new TinyCloudWeb(buildConfig(undefined, policy));
  const result = await tc.restoreSession(address);
  if (result.status !== "restored") {
    try {
      localStorage.removeItem(LAST_ADDRESS_KEY);
    } catch {
      // No-op.
    }
    return null;
  }
  instance = tc;
  walletMode = false;
  return { address, readerDid: tc.did };
}

export async function submitFeedHostDelegations(input: {
  client: FeedV1HostClient;
  policy: FeedHostDelegationPolicy;
  actorId: string;
}): Promise<FeedHostDelegationReceipt[]> {
  if (!instance) throw new Error("TinyCloud session is required before creating Feed Host delegations");
  const cached = cachedDelegations(input.actorId, input.policy);
  if (cached) {
    try {
      return await submitCachedDelegations(input.client, input.actorId, cached);
    } catch (error) {
      clearCachedDelegations();
      if (!walletMode) throw reconnectRequiredError(error);
    }
  }
  if (!walletMode) throw reconnectRequiredError();

  const receipts: FeedHostDelegationReceipt[] = [];
  const cachedResources: CachedFeedHostDelegation["resources"] = [];
  for (const resource of input.policy.resources) {
    const result = await instance.space("default").delegations.create({
      delegateDID: input.policy.delegateDID,
      path: resource.path,
      actions: resource.actions,
      expiry: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    if (!result.ok) throw new Error(result.error.message);
    const serializedDelegation = serializeDelegation(toPortableDelegation(result.data, instance));
    cachedResources.push({ path: resource.path, actions: resource.actions, serializedDelegation });
    receipts.push(await input.client.submitDelegation({ actorId: input.actorId, serializedDelegation }));
  }
  saveCachedDelegations({
    actorId: input.actorId,
    delegateDID: input.policy.delegateDID,
    resources: cachedResources,
  });
  return receipts;
}

export async function signOut(): Promise<void> {
  try {
    await instance?.signOut();
  } finally {
    instance = null;
    walletMode = false;
    try {
      localStorage.removeItem(LAST_ADDRESS_KEY);
      localStorage.removeItem(DELEGATION_CACHE_KEY);
    } catch {
      // No-op.
    }
  }
}

function toPortableDelegation(delegation: Delegation, tc: TinyCloudWeb): PortableDelegation {
  const { isRevoked: _isRevoked, ...rest } = delegation;
  return {
    ...rest,
    delegationHeader: {
      Authorization: delegation.authHeader || `Bearer ${delegation.cid}`,
    },
    ownerAddress: tc.address() ?? "",
    chainId: tc.chainId() ?? 1,
    host: TINYCLOUD_HOST,
  };
}

function cachedDelegations(actorId: string, policy: FeedHostDelegationPolicy): CachedFeedHostDelegation | null {
  let cached: CachedFeedHostDelegation | null = null;
  try {
    const raw = localStorage.getItem(DELEGATION_CACHE_KEY);
    cached = raw ? JSON.parse(raw) as CachedFeedHostDelegation : null;
  } catch {
    clearCachedDelegations();
    return null;
  }
  if (!cached || cached.actorId !== actorId || cached.delegateDID !== policy.delegateDID) return null;
  const cachedByPath = new Map(cached.resources.map((resource) => [resource.path, resource]));
  for (const resource of policy.resources) {
    const match = cachedByPath.get(resource.path);
    if (!match || !sameActions(match.actions, resource.actions)) return null;
  }
  return cached;
}

async function submitCachedDelegations(
  client: FeedV1HostClient,
  actorId: string,
  cached: CachedFeedHostDelegation,
): Promise<FeedHostDelegationReceipt[]> {
  const receipts: FeedHostDelegationReceipt[] = [];
  for (const resource of cached.resources) {
    receipts.push(await client.submitDelegation({ actorId, serializedDelegation: resource.serializedDelegation }));
  }
  return receipts;
}

function saveCachedDelegations(cached: CachedFeedHostDelegation): void {
  try {
    localStorage.setItem(DELEGATION_CACHE_KEY, JSON.stringify(cached));
  } catch {
    // Delegation cache is a convenience; wallet-mode sign-in can recreate it.
  }
}

function clearCachedDelegations(): void {
  try {
    localStorage.removeItem(DELEGATION_CACHE_KEY);
  } catch {
    // No-op.
  }
}

function sameActions(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const granted = new Set(left);
  return right.every((action) => granted.has(action));
}

function reconnectRequiredError(cause?: unknown): Error {
  const message = cause instanceof Error ? ` ${cause.message}` : "";
  return new Error(`Feed Host needs a fresh wallet-backed delegation. Sign in with OpenKey again.${message}`);
}
