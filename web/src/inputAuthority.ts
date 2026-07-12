export type DelegateReceivedShareOptions = {
  delegateDID: string;
  path?: string;
  actions?: string[];
  expiry?: Date;
  expectedHost?: string;
};

export type ReceivedShareSdkBoundary = {
  sharing: {
    delegateReceivedShare(
      tc1Link: string,
      options: DelegateReceivedShareOptions,
    ): Promise<unknown>;
  };
};

export type ChildInputAuthoritySubmission = {
  sourceId: string;
  displayName: string;
  portableDelegation: string;
};

/**
 * Browser-only attenuation boundary. The raw tc1 link and active-session key
 * remain inside the SDK call; only the child portable delegation is returned
 * for submission to Feed Host.
 */
export async function delegateInputAuthorityLocally(input: {
  sdk: unknown;
  tc1Link: string;
  sourceId: string;
  displayName: string;
  delegateDID: string;
  path?: string;
  actions?: string[];
  expiry?: string;
  expectedHost?: string;
}): Promise<ChildInputAuthoritySubmission> {
  if (!input.tc1Link.startsWith("tc1:")) throw new Error("A TinyCloud received-share link is required");
  const sdk = receivedShareSdk(input.sdk);
  let result: unknown;
  try {
    result = await sdk.sharing.delegateReceivedShare(input.tc1Link, {
      delegateDID: input.delegateDID,
      ...(input.path ? { path: input.path } : {}),
      ...(input.actions ? { actions: input.actions } : {}),
      ...(input.expiry ? { expiry: new Date(input.expiry) } : {}),
      ...(input.expectedHost ? { expectedHost: input.expectedHost } : {}),
    });
  } catch {
    throw new Error("TinyCloud could not delegate the received share");
  }
  const portableDelegation = portableDelegationFromResult(result);
  if (!portableDelegation || portableDelegation.startsWith("tc1:")) {
    throw new Error("TinyCloud SDK did not return a child portable delegation");
  }
  return {
    sourceId: input.sourceId,
    displayName: input.displayName,
    portableDelegation,
  };
}

export function receivedShareDelegationAvailable(sdk: unknown): boolean {
  return Boolean(receivedShareSdkOrNull(sdk));
}

function receivedShareSdk(sdk: unknown): ReceivedShareSdkBoundary {
  const compatible = receivedShareSdkOrNull(sdk);
  if (!compatible) throw new Error("TinyCloud SDK update required for received-share delegation");
  return compatible;
}

function receivedShareSdkOrNull(sdk: unknown): ReceivedShareSdkBoundary | null {
  if (!sdk || typeof sdk !== "object") return null;
  const sharing = (sdk as { sharing?: unknown }).sharing;
  if (!sharing || typeof sharing !== "object") return null;
  const delegateReceivedShare = (sharing as { delegateReceivedShare?: unknown }).delegateReceivedShare;
  return typeof delegateReceivedShare === "function" ? sdk as ReceivedShareSdkBoundary : null;
}

function portableDelegationFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (record.ok !== true || !record.data || typeof record.data !== "object" || Array.isArray(record.data)) return null;
  const delegation = (record.data as Record<string, unknown>).delegation;
  if (!delegation || typeof delegation !== "object" || Array.isArray(delegation)) return null;
  try {
    const expiry = (delegation as Record<string, unknown>).expiry;
    return JSON.stringify({
      ...(delegation as Record<string, unknown>),
      ...(expiry instanceof Date ? { expiry: expiry.toISOString() } : {}),
    });
  } catch {
    return null;
  }
}
