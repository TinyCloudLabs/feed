// Lazy seam for the auth stack. The TinyCloud web SDK plus ethers account
// for ~3.4MB of the bundle but are only exercised by session machinery, so
// they load as an async chunk instead of gating first paint. Types re-export
// with zero runtime cost; each function awaits the chunk on first use (the
// bootstrap restoreSession call starts the download in parallel with render).
import type { FeedHostDelegationPolicy } from "./delegation.ts";

export type { FeedLoginTrace, FeedSession } from "./auth.ts";

type AuthModule = typeof import("./auth.ts");

let modulePromise: Promise<AuthModule> | undefined;

function auth(): Promise<AuthModule> {
  modulePromise ??= import("./auth.ts");
  return modulePromise;
}

export async function signIn(
  ...args: Parameters<AuthModule["signIn"]>
): ReturnType<AuthModule["signIn"]> {
  return (await auth()).signIn(...args);
}

export async function restoreSession(
  policy?: FeedHostDelegationPolicy,
): ReturnType<AuthModule["restoreSession"]> {
  return (await auth()).restoreSession(policy);
}

export async function signOut(
  ...args: Parameters<AuthModule["signOut"]>
): ReturnType<AuthModule["signOut"]> {
  return (await auth()).signOut(...args);
}

export async function submitFeedHostDelegations(
  ...args: Parameters<AuthModule["submitFeedHostDelegations"]>
): ReturnType<AuthModule["submitFeedHostDelegations"]> {
  return (await auth()).submitFeedHostDelegations(...args);
}

export async function attachReceivedInputAuthority(
  ...args: Parameters<AuthModule["attachReceivedInputAuthority"]>
): ReturnType<AuthModule["attachReceivedInputAuthority"]> {
  return (await auth()).attachReceivedInputAuthority(...args);
}
