import {
  BrowserSessionStorage,
  composeManifestRequest,
  PermissionNotInManifestError,
  serializeDelegation,
  SessionExpiredError,
  TinyCloudWeb,
  type Config,
  type Manifest,
} from "@tinycloud/web-sdk";
import type { providers } from "ethers";
import { TINYCLOUD_HOST } from "./config.ts";
import type { FeedHostDelegationPolicy, FeedHostDelegationReceipt } from "./delegation.ts";
import { FeedV1HostClient } from "./feedV1HostClient.ts";
import { errorDetail, reportClientEvent } from "./clientLog.ts";
import { delegateInputAuthorityLocally } from "./inputAuthority.ts";
import { connectWallet } from "./openkey.ts";
import { isRetryableDelegationConflict, isRetryableSpaceCreationFailure } from "./delegationRetry.ts";
import {
  FEED_MANIFEST,
  FeedReconnectRequiredError,
} from "./authPolicy.ts";

const SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const DELEGATION_RETRY_DELAYS_MS = [1000, 3000, 7000, 12000];
const SPACE_CREATION_RETRY_DELAYS_MS = [1000, 3000];
const LAST_ADDRESS_KEY = "feed:v1:lastAddress";

let instance: TinyCloudWeb | null = null;

export type FeedSession = {
  address: string;
  readerDid: string;
};

function delegationManifest(policy: FeedHostDelegationPolicy): Manifest {
  return {
    manifest_version: 1,
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

function feedCapabilityRequest(policy: FeedHostDelegationPolicy) {
  return composeManifestRequest([FEED_MANIFEST, delegationManifest(policy)]);
}

function buildConfig(web3Provider?: providers.Web3Provider, policy?: FeedHostDelegationPolicy): Config {
  return {
    ...(web3Provider ? { providers: { web3: { driver: web3Provider } } } : {}),
    tinycloudHosts: [TINYCLOUD_HOST],
    ...(policy
      ? { capabilityRequest: feedCapabilityRequest(policy) }
      : { manifest: FEED_MANIFEST }),
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
  await signInWithSpaceCreationRetry(tc);
  instance = tc;
  try {
    localStorage.setItem(LAST_ADDRESS_KEY, address);
  } catch {
    // Restore is best-effort; sign-in still succeeded.
  }
  return { address, readerDid: tc.did };
}

async function signInWithSpaceCreationRetry(tc: TinyCloudWeb): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await tc.signIn();
      return;
    } catch (error) {
      const delay = SPACE_CREATION_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryableSpaceCreationFailure(error)) throw error;
      reportClientEvent("warn", "sign_in_space_retry", `attempt=${attempt + 1}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
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
  return { address, readerDid: tc.did };
}

export async function submitFeedHostDelegations(input: {
  client: FeedV1HostClient;
  policy: FeedHostDelegationPolicy;
  actorId: string;
}): Promise<FeedHostDelegationReceipt[]> {
  if (!instance) throw new Error("TinyCloud session is required before creating Feed Host delegations");
  let serializedDelegation: string;
  try {
    const result = await materializeFeedHostDelegation(instance, input.policy, input.actorId);
    if (result.prompted) {
      throw new Error("Feed Host delegation unexpectedly required another wallet approval");
    }
    serializedDelegation = serializeDelegation(result.delegation);
  } catch (error) {
    reportClientEvent("error", "delegation_mint_failed", errorDetail(error), input.actorId);
    if (isSessionScopeError(error)) throw reconnectRequiredError(error);
    throw error;
  }
  return [await input.client.submitDelegation({ actorId: input.actorId, serializedDelegation })];
}

async function materializeFeedHostDelegation(
  tc: TinyCloudWeb,
  policy: FeedHostDelegationPolicy,
  actorId: string,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await tc.materializeDelegation(policy.delegateDID, feedCapabilityRequest(policy));
    } catch (error) {
      const delay = DELEGATION_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryableDelegationConflict(error)) throw error;
      reportClientEvent("warn", "delegation_serialization_retry", `attempt=${attempt + 1}`, actorId);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function attachReceivedInputAuthority(input: {
  client: FeedV1HostClient;
  policy: FeedHostDelegationPolicy;
  sourceId: string;
  displayName: string;
  tc1Link: string;
}): Promise<void> {
  if (!instance) throw new Error("TinyCloud session is required before attaching an input source");
  const submission = await delegateInputAuthorityLocally({
    sdk: instance,
    tc1Link: input.tc1Link,
    sourceId: input.sourceId,
    displayName: input.displayName,
    delegateDID: input.policy.delegateDID,
    expectedHost: TINYCLOUD_HOST,
  });
  await input.client.attachInputAuthority(submission);
}

// Session-scope failures (recap doesn't cover the policy, or the session is
// expired/expiring) are fixed by signing in again — not by retrying.
function isSessionScopeError(error: unknown): boolean {
  if (error instanceof PermissionNotInManifestError || error instanceof SessionExpiredError) return true;
  const name = (error as { name?: string } | null)?.name;
  return name === "PermissionNotInManifestError" || name === "SessionExpiredError";
}

export async function signOut(): Promise<void> {
  try {
    await instance?.signOut();
  } finally {
    instance = null;
    try {
      localStorage.removeItem(LAST_ADDRESS_KEY);
    } catch {
      // No-op.
    }
  }
}

function reconnectRequiredError(cause?: unknown): FeedReconnectRequiredError {
  return new FeedReconnectRequiredError(cause);
}
