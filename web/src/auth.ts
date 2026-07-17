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
import { FeedV1HostClient, FeedV1HostError } from "./feedV1HostClient.ts";
import {
  errorDetail,
  reportClientEvent,
  reportClientTiming,
  type ClientSessionMode,
  type DelegationFailureStage,
} from "./clientLog.ts";
import { delegateInputAuthorityLocally } from "./inputAuthority.ts";
import { connectWallet, type ConnectWalletResult } from "./openkey.ts";
import { isRetryableDelegationConflict, isRetryableSpaceCreationFailure } from "./delegationRetry.ts";
import {
  FEED_MANIFEST,
  FeedReconnectRequiredError,
  MISSING_PARENT_RECONNECT_MESSAGE,
} from "./authPolicy.ts";
import {
  isMissingParentDelegationError,
  recoverMissingParentDelegation,
} from "./missingParentDelegation.ts";

const SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;
const DELEGATION_RETRY_DELAYS_MS = [1000, 3000, 7000, 12000];
const SPACE_CREATION_RETRY_DELAYS_MS = [1000, 3000];
const LAST_ADDRESS_KEY = "feed:v1:lastAddress";

let instance: TinyCloudWeb | null = null;
let activeWallet: ConnectWalletResult | null = null;
let activeSessionMode: ClientSessionMode | null = null;
let createTinyCloudWeb = (config: Config): TinyCloudWeb => new TinyCloudWeb(config);
let reportRecoveryClientEvent: typeof reportClientEvent = reportClientEvent;

/** @internal Test seam for exercising the real auth-operation recovery path. */
export function overrideFeedAuthForTest(input: {
  instance?: TinyCloudWeb | null;
  activeWallet?: ConnectWalletResult | null;
  activeSessionMode?: ClientSessionMode | null;
  createTinyCloudWeb?: (config: Config) => TinyCloudWeb;
  reportRecoveryClientEvent?: typeof reportClientEvent;
}): () => void {
  const previous = {
    instance,
    activeWallet,
    activeSessionMode,
    createTinyCloudWeb,
    reportRecoveryClientEvent,
  };
  if ("instance" in input) instance = input.instance ?? null;
  if ("activeWallet" in input) activeWallet = input.activeWallet ?? null;
  if ("activeSessionMode" in input) activeSessionMode = input.activeSessionMode ?? null;
  if (input.createTinyCloudWeb) createTinyCloudWeb = input.createTinyCloudWeb;
  if (input.reportRecoveryClientEvent) reportRecoveryClientEvent = input.reportRecoveryClientEvent;
  return () => {
    instance = previous.instance;
    activeWallet = previous.activeWallet;
    activeSessionMode = previous.activeSessionMode;
    createTinyCloudWeb = previous.createTinyCloudWeb;
    reportRecoveryClientEvent = previous.reportRecoveryClientEvent;
  };
}

export type FeedSession = {
  address: string;
  readerDid: string;
};

export type FeedLoginTrace = {
  traceId: string;
  loginStartedAt: number;
  systemStartedAt?: number;
  systemElapsedBeforeApprovalMs?: number;
  sessionMode: "fresh" | "restored";
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

export async function signIn(policy: FeedHostDelegationPolicy, trace?: FeedLoginTrace): Promise<FeedSession> {
  // signIn is the explicit, user-initiated bootstrap. A preserved address is
  // only a restore pointer and must not relabel this fresh SDK session.
  const sessionMode: ClientSessionMode = "fresh";
  const walletStartedAt = performance.now();
  const wallet = await connectWallet();
  const { address, web3Provider } = wallet;
  if (trace) reportClientTiming("login_wallet_connected", { ...trace, sessionMode, phaseStartedAt: walletStartedAt });
  const tc = createTinyCloudWeb(buildConfig(web3Provider, policy));
  const tinyCloudStartedAt = performance.now();
  await signInWithSpaceCreationRetry(tc);
  if (trace) {
    reportClientTiming("login_tinycloud_signed_in", {
      ...trace,
      sessionMode,
      phaseStartedAt: tinyCloudStartedAt,
      actorId: tc.did,
    });
  }
  instance = tc;
  activeWallet = wallet;
  activeSessionMode = tc.sessionRestoreStatus === "restored" ? "restored" : "fresh";
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
  const tc = createTinyCloudWeb(buildConfig(undefined, policy));
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
  activeWallet = null;
  activeSessionMode = "restored";
  return { address, readerDid: tc.did };
}

export async function submitFeedHostDelegations(input: {
  client: FeedV1HostClient;
  policy: FeedHostDelegationPolicy;
  actorId: string;
  trace?: FeedLoginTrace;
}): Promise<FeedHostDelegationReceipt[]> {
  let recoveryStage: DelegationFailureStage = "mint";
  const sessionMode = activeSessionMode ?? input.trace?.sessionMode ?? "restored";

  const attempt = async (): Promise<FeedHostDelegationReceipt[]> => {
    if (!instance) throw new Error("TinyCloud session is required before creating Feed Host delegations");
    let serializedDelegation: string;
    try {
      recoveryStage = "mint";
      const materializeStartedAt = performance.now();
      const result = await materializeFeedHostDelegation(instance, input.policy, input.actorId);
      if (input.trace) {
        reportClientTiming("login_delegation_materialized", {
          ...input.trace,
          phaseStartedAt: materializeStartedAt,
          actorId: input.actorId,
        });
      }
      if (result.prompted) {
        throw new Error("Feed Host delegation unexpectedly required another wallet approval");
      }
      serializedDelegation = serializeDelegation(result.delegation);
    } catch (error) {
      recoveryStage = isMissingParentDelegationError(error) ? "activate" : "mint";
      reportClientEvent("error", "delegation_mint_failed", errorDetail(error), input.actorId, {
        stage: recoveryStage,
        session_mode: sessionMode,
      });
      if (isSessionScopeError(error)) throw reconnectRequiredError(error);
      throw error;
    }
    const submitStartedAt = performance.now();
    let receipt: FeedHostDelegationReceipt;
    try {
      receipt = await input.client.submitDelegation({ actorId: input.actorId, serializedDelegation });
    } catch (error) {
      recoveryStage = delegationSubmissionFailureStage(error);
      reportClientEvent("error", "delegation_mint_failed", errorDetail(error), input.actorId, {
        stage: recoveryStage,
        session_mode: sessionMode,
      });
      throw error;
    }
    if (input.trace) {
      reportClientTiming("login_delegation_accepted", {
        ...input.trace,
        phaseStartedAt: submitStartedAt,
        actorId: input.actorId,
        detail: `setup=${receipt.setup?.state ?? "unknown"}`,
      });
    }
    return [receipt];
  };

  try {
    return await attempt();
  } catch (error) {
    if (!isMissingParentDelegationError(error)) throw error;
    recoveryStage = "activate";
    return recoverMissingParentOperation({
      initialError: error,
      policy: input.policy,
      actorId: input.actorId,
      sessionMode,
      stage: recoveryStage,
      retry: attempt,
    });
  }
}

export function delegationSubmissionFailureStage(error: unknown): "submit" | "activate" {
  if (!(error instanceof FeedV1HostError)) return "submit";
  try {
    const body = JSON.parse(error.body) as { error?: { code?: unknown } };
    const code = body.error?.code;
    const normalizedCode = typeof code === "string" ? code.toLowerCase() : "";
    return normalizedCode === "invalid_delegation"
      || normalizedCode === "delegation_stale"
      || normalizedCode === "denied"
      || normalizedCode === "actor_mismatch"
      || normalizedCode === "missing_parent_delegation"
      || normalizedCode === "parent_delegation_not_found"
      ? "activate"
      : "submit";
  } catch {
    return "submit";
  }
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
  const actorId = instance?.did;
  const sessionMode = activeSessionMode ?? "restored";
  let recoveryStage: DelegationFailureStage = "mint";
  const attempt = async (): Promise<void> => {
    if (!instance) throw new Error("TinyCloud session is required before attaching an input source");
    recoveryStage = "mint";
    const submission = await delegateInputAuthorityLocally({
      sdk: instance,
      tc1Link: input.tc1Link,
      sourceId: input.sourceId,
      displayName: input.displayName,
      delegateDID: input.policy.delegateDID,
      expectedHost: TINYCLOUD_HOST,
    });
    try {
      await input.client.attachInputAuthority(submission);
    } catch (error) {
      recoveryStage = delegationSubmissionFailureStage(error);
      throw error;
    }
  };

  try {
    await attempt();
  } catch (error) {
    if (!isMissingParentDelegationError(error)) throw error;
    recoveryStage = "activate";
    await recoverMissingParentOperation({
      initialError: error,
      policy: input.policy,
      actorId,
      sessionMode,
      stage: recoveryStage,
      retry: attempt,
    });
  }
}

// Session-scope failures (recap doesn't cover the policy, or the session is
// expired/expiring) are fixed by signing in again — not by retrying.
function isSessionScopeError(error: unknown): boolean {
  if (error instanceof PermissionNotInManifestError || error instanceof SessionExpiredError) return true;
  const name = (error as { name?: string } | null)?.name;
  return name === "PermissionNotInManifestError" || name === "SessionExpiredError";
}

async function recoverMissingParentOperation<T>(input: {
  initialError: unknown;
  policy: FeedHostDelegationPolicy;
  actorId?: string;
  sessionMode: ClientSessionMode;
  stage: DelegationFailureStage;
  retry: () => Promise<T>;
}): Promise<T> {
  const result = await recoverMissingParentDelegation({
    initialError: input.initialError,
    clearSession: () => clearFeedSessionState({ preserveAddress: true, preserveWallet: true }),
    reauthenticateSilently: () => reauthenticateSilently(input.policy),
    retry: input.retry,
    onOutcome: (outcome) => {
      reportRecoveryClientEvent(outcome === "healed" ? "info" : "warn", "missing_parent_recovery", undefined, input.actorId, {
        session_mode: input.sessionMode,
        stage: input.stage,
        outcome,
      });
    },
  });
  if (result.status === "reconnect_required") {
    throw new FeedReconnectRequiredError(result.error, MISSING_PARENT_RECONNECT_MESSAGE);
  }
  return result.value;
}

async function reauthenticateSilently(policy: FeedHostDelegationPolicy): Promise<boolean> {
  const wallet = activeWallet;
  if (!wallet || !await wallet.canSignSilently()) return false;

  const tc = createTinyCloudWeb(buildConfig(wallet.web3Provider, policy));
  await signInWithSpaceCreationRetry(tc);
  instance = tc;
  activeSessionMode = "fresh";
  return true;
}

async function clearFeedSessionState(options: {
  preserveAddress?: boolean;
  preserveWallet?: boolean;
} = {}): Promise<void> {
  const current = instance;
  const address = savedAddress();
  instance = null;
  activeSessionMode = null;
  if (!options.preserveWallet) activeWallet = null;

  try {
    await current?.signOut();
  } catch {
    // Local teardown below is authoritative. A stale/failed SDK sign-out
    // must not prevent recovery or the explicit Disconnect path.
  } finally {
    // The same storage adapter backs TinyCloudWeb. Clearing it directly also
    // handles a partially initialized instance while keeping all session
    // teardown in this one helper shared by Disconnect and recovery.
    if (address) {
      await new BrowserSessionStorage().clear(address).catch(() => undefined);
    }
    if (!options.preserveAddress) {
      try {
        localStorage.removeItem(LAST_ADDRESS_KEY);
      } catch {
        // No-op.
      }
    }
  }
}

export async function signOut(options: { preserveAddress?: boolean } = {}): Promise<void> {
  await clearFeedSessionState({ preserveAddress: options.preserveAddress });
}

function reconnectRequiredError(cause?: unknown): FeedReconnectRequiredError {
  return new FeedReconnectRequiredError(cause);
}
