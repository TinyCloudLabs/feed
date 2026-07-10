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
import { TINYCLOUD_HOST } from "./config.ts";
import type { FeedHostDelegationPolicy, FeedHostDelegationReceipt } from "./delegation.ts";
import { FeedV1HostClient } from "./feedV1HostClient.ts";
import { connectWallet } from "./openkey.ts";
import {
  FEED_MANIFEST,
  FeedReconnectRequiredError,
} from "./authPolicy.ts";

const SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const LAST_ADDRESS_KEY = "feed:v1:lastAddress";
const DELEGATION_CACHE_KEY = "feed:v1:hostDelegations";

let instance: TinyCloudWeb | null = null;
let walletMode = false;

export type FeedSession = {
  address: string;
  readerDid: string;
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

function buildConfig(web3Provider?: providers.Web3Provider, policy?: FeedHostDelegationPolicy): Config {
  return {
    ...(web3Provider ? { providers: { web3: { driver: web3Provider } } } : {}),
    tinycloudHosts: [TINYCLOUD_HOST],
    manifest: policy ? [FEED_MANIFEST, delegationManifest(policy)] : FEED_MANIFEST,
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

function reconnectRequiredError(cause?: unknown): FeedReconnectRequiredError {
  return new FeedReconnectRequiredError(cause);
}
