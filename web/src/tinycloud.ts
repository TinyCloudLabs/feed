// tinycloud.ts — browser web-SDK session for the viewer.
//
// The user signs in as the space OWNER over a BROADENED `applications`-space
// manifest: the artifacts feed/interactions/media the viewer reads + writes,
// PLUS the Listen-read caps the user delegates to the agent. The wider recap is
// what lets `delegateTo(agentDid, scopes)` derive the agent's grant from the
// session key with no extra wallet prompt — `delegateTo`'s subset check is
// against the signed recap's PERMISSIONS, independent of the agent DID (which
// is discovered at runtime via GET /agent/info).

import {
  TinyCloudWeb,
  BrowserSessionStorage,
  type Config,
  type Manifest,
  type PermissionEntry,
} from "@tinycloud/web-sdk";
import type { providers } from "ethers";
import { connectWallet } from "./openkey.ts";

const HOST = import.meta.env.VITE_TINYCLOUD_HOST || "https://node.tinycloud.xyz";

/** Session TTL for the persisted browser session. The SDK default is 1 HOUR,
 *  which forces a re-sign-in mid-session; 7 days lets the local session
 *  genuinely persist across reloads / new tabs / "continue reading". This MUST
 *  be identical on sign-in and restore so the restored session honors the same
 *  lifetime the recap was minted with. */
const SESSION_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

/** localStorage key holding the last signed-in wallet address. A later reload
 *  reads this to know WHICH persisted session key to restore (the SDK keys its
 *  BrowserSessionStorage by `address.toLowerCase()`), so restore needs no wallet
 *  prompt to discover the address. */
const LAST_ADDRESS_KEY = "feed:lastAddress";

/** The artifacts app namespace (contract: xyz.tinycloud.artifacts). */
export const ARTIFACTS_APP_ID = "xyz.tinycloud.artifacts";

/** Contract §1 DB paths (within the applications space). */
export const FEED_DB = "xyz.tinycloud.artifacts/feed";
export const INTERACTIONS_DB = "xyz.tinycloud.artifacts/interactions";
/** Contract §2 media KV prefix (trailing slash = prefix semantics). */
export const MEDIA_PREFIX = "xyz.tinycloud.artifacts/media/";

/** Listen data source the agent reads under delegation (lives in the SAME
 *  `applications` space as the artifacts). Conversations are SQL; transcripts
 *  are KV under the `xyz.tinycloud.listen/` prefix (trailing slash = prefix). */
export const LISTEN_CONVERSATIONS_DB = "xyz.tinycloud.listen/conversations";
export const LISTEN_KV_PREFIX = "xyz.tinycloud.listen/";

/** The exact scopes the user delegates to the agent (Listen-read +
 *  artifacts-read/write). The agent runs the artifact pipeline under these,
 *  publishing to the user's OWN `applications` space. Exported so the Connect/
 *  Agents pages mint the delegation with the same set the manifest broadened
 *  the recap to cover. */
export const AGENT_SCOPES: PermissionEntry[] = [
  {
    service: "tinycloud.sql",
    space: "applications",
    path: LISTEN_CONVERSATIONS_DB,
    actions: ["read"],
    description: "Read Listen conversations to generate artifacts.",
  },
  {
    service: "tinycloud.kv",
    space: "applications",
    path: LISTEN_KV_PREFIX,
    actions: ["get", "list", "metadata"],
    description: "Read Listen transcripts to generate artifacts.",
  },
  {
    service: "tinycloud.sql",
    space: "applications",
    path: FEED_DB,
    actions: ["read", "write"],
    description: "Publish generated artifacts to the feed.",
  },
  {
    service: "tinycloud.sql",
    space: "applications",
    path: INTERACTIONS_DB,
    actions: ["read"],
    description: "Read interactions to shape generated artifacts.",
  },
  {
    service: "tinycloud.kv",
    space: "applications",
    path: MEDIA_PREFIX,
    // Minimal: the agent reads/writes hero blobs BY KEY (the SQL pointer carries
    // the exact key) — it never enumerates the user's media, so no list/metadata.
    actions: ["get", "put"],
    description: "Read/write artifact media (hero images) by key.",
  },
];

// Manifest: declare exactly the caps the viewer needs on the applications
// space (artifacts read/interactions + media) PLUS the agent's delegated scopes,
// so the signed recap covers everything `delegateTo(agentDid, AGENT_SCOPES)`
// derives. `prefix: ""` disables the auto app-id prefix so our full contract
// paths are used verbatim (otherwise the SDK would prepend `xyz.tinycloud.artifacts`).
//
// An optional agent delegation TARGET is declared (manifest `did`) when
// VITE_AGENT_DID is configured at build time — the agent's stable did:pkh. This
// is advisory: the derivation does not need it, but declaring it surfaces the
// delegate in the SDK's composed request for tooling that inspects targets.
const AGENT_DID = import.meta.env.VITE_AGENT_DID || "";

const MANIFEST: Manifest = {
  app_id: ARTIFACTS_APP_ID,
  name: "TinyFeed",
  description: "Reads the artifact feed, records reader interactions, and delegates generation to an agent.",
  space: "applications",
  prefix: "",
  defaults: false,
  permissions: [
    {
      service: "tinycloud.sql",
      space: "applications",
      path: FEED_DB,
      actions: ["read"],
      description: "Read the published artifact feed.",
    },
    {
      service: "tinycloud.sql",
      space: "applications",
      path: INTERACTIONS_DB,
      actions: ["read", "write"],
      description: "Append reader interaction events.",
    },
    {
      service: "tinycloud.kv",
      space: "applications",
      path: MEDIA_PREFIX,
      actions: ["get", "list", "metadata"],
      description: "Read artifact media (hero images, audio).",
    },
    // Agent-delegated scopes, unioned into the recap so delegateTo derives.
    ...AGENT_SCOPES,
  ],
};

/** Optional agent delegation-target manifest. Carries the SAME permission set
 *  as AGENT_SCOPES under the agent's `did`, so the composed request lists the
 *  delegate explicitly when the DID is known at build time. Omitted when
 *  VITE_AGENT_DID is unset (the runtime delegateTo path is unaffected). */
const AGENT_MANIFEST: Manifest | null = AGENT_DID
  ? {
      app_id: ARTIFACTS_APP_ID,
      name: "Feed Agent",
      description: "The distillery agent that generates artifacts under the user's delegation.",
      did: AGENT_DID,
      space: "applications",
      prefix: "",
      defaults: false,
      permissions: AGENT_SCOPES,
    }
  : null;

let instance: TinyCloudWeb | null = null;

/** The signed-in singleton. Throws before `signIn()` — every read/write path
 *  runs inside an active session, so an absent instance is a bug, not a state
 *  to paper over. */
export function tcw(): TinyCloudWeb {
  if (!instance) throw new Error("TinyCloud is not signed in");
  return instance;
}

/** The composed sign-in manifest: the app's own caps + the optional agent
 *  delegation target, so the single SIWE recap covers everything `delegateTo`
 *  later derives. This MUST be identical on sign-in and restore — a manifest
 *  mismatch makes the persisted recap unrecognizable and restore fails. */
const COMPOSED_MANIFEST: Manifest | Manifest[] = AGENT_MANIFEST
  ? [MANIFEST, AGENT_MANIFEST]
  : MANIFEST;

/** Build the TinyCloudWeb config shared by sign-in and restore. Pass the OpenKey
 *  web3 provider on sign-in (so the real SIWE/OpenKey delegation runs); omit it
 *  on restore (so the SDK rehydrates the persisted session key WITHOUT a passkey
 *  prompt). Everything else — manifest, hosts, session storage, TTL — is held
 *  IDENTICAL across both paths so the restored session matches what was signed. */
function buildConfig(web3Provider?: providers.Web3Provider): Config {
  return {
    ...(web3Provider ? { providers: { web3: { driver: web3Provider } } } : {}),
    tinycloudHosts: [HOST],
    manifest: COMPOSED_MANIFEST,
    sessionStorage: new BrowserSessionStorage(),
    sessionExpirationMs: SESSION_EXPIRATION_MS,
  };
}

/** Read the last signed-in address from localStorage, or null if none/cleared. */
function lastSignedInAddress(): string | null {
  try {
    return localStorage.getItem(LAST_ADDRESS_KEY);
  } catch {
    return null;
  }
}

/** Sign in via OpenKey passkey, delegating the manifest's `applications`-space
 *  caps to this session, and return the owner's applications-space URI (which
 *  scopes all feed/interactions/media access).
 *
 *  Constructing TinyCloudWeb WITH the OpenKey wallet provider is what makes
 *  `signIn()` run the real SIWE/OpenKey delegation over `MANIFEST` — without a
 *  provider the SDK has no signer and falls into session-only mode (can't reach
 *  the applications space). The wallet address is persisted so a later reload
 *  can restore this session headlessly via {@link restoreSession}. */
export async function signIn(): Promise<{ appsSpaceUri: string; readerDid: string }> {
  const { web3Provider, address } = await connectWallet();
  const t = new TinyCloudWeb(buildConfig(web3Provider));
  await t.signIn();
  instance = t;
  // Persist the address so restore-on-mount knows which session key to rehydrate.
  try {
    localStorage.setItem(LAST_ADDRESS_KEY, address);
  } catch {
    // localStorage unavailable — restore won't work, but sign-in still does.
  }
  const appsSpaceUri = t.space("applications").id;
  // Reader DID = the active session principal (contract §1.2: advisory in v1;
  // a trusted writer principal is a server-side upgrade).
  const readerDid = t.did;
  return { appsSpaceUri, readerDid };
}

/** Restore a persisted session WITHOUT a wallet/passkey prompt.
 *
 *  Constructs TinyCloudWeb with the SAME manifest/hosts/storage/TTL as sign-in
 *  but NO web3 provider, then asks the SDK to rehydrate the session key the
 *  prior sign-in persisted (BrowserSessionStorage, keyed by the stored address).
 *  Returns the same shape as `signIn()` when restored, or null when there is
 *  nothing to restore (missing/expired). A CORRUPT or unexpected-failure status
 *  throws — we don't paper over a real restore failure (standing rule), we
 *  surface it and let the caller fall back to sign-in. */
export async function restoreSession(): Promise<{ appsSpaceUri: string; readerDid: string } | null> {
  const address = lastSignedInAddress();
  if (!address) return null;
  const t = new TinyCloudWeb(buildConfig());
  const result = await t.restoreSession(address);
  if (result.status === "restored") {
    instance = t;
    const appsSpaceUri = t.space("applications").id;
    const readerDid = t.did;
    return { appsSpaceUri, readerDid };
  }
  // Nothing to restore: clear the stale address pointer so we don't keep trying.
  if (result.status === "missing" || result.status === "expired") {
    try {
      localStorage.removeItem(LAST_ADDRESS_KEY);
    } catch {
      // ignore
    }
    return null;
  }
  // corrupt / restore-failed / storage-unavailable / disabled: a real problem —
  // surface it rather than silently falling back.
  throw result.error ?? new Error(`session restore failed: ${result.status}`);
}

export async function signOut(): Promise<void> {
  // Clear the restore pointers FIRST and unconditionally: if the SDK signOut
  // below throws, the persisted session must NOT remain restorable. Drop the
  // local address pointer and the SDK's persisted session (BrowserSessionStorage)
  // before tearing down the instance.
  try {
    localStorage.removeItem(LAST_ADDRESS_KEY);
  } catch {
    // ignore
  }
  if (instance) {
    const t = instance;
    instance = null;
    await t.clearPersistedSession();
    await t.signOut();
  }
}

export { HOST, AGENT_DID };
