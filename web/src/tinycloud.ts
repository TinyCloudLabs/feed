// tinycloud.ts — browser web-SDK session for the viewer.
//
// The user signs in as the space OWNER over a BROADENED `applications`-space
// manifest: the artifacts feed/interactions/media the viewer reads + writes,
// PLUS the Listen-read caps the user delegates to the agent. The wider recap is
// what lets `delegateTo(agentDid, scopes)` derive the agent's grant from the
// session key with no extra wallet prompt — `delegateTo`'s subset check is
// against the signed recap's PERMISSIONS, independent of the agent DID (which
// is discovered at runtime via GET /agent/info).

import { TinyCloudWeb, type Config, type Manifest, type PermissionEntry } from "@tinycloud/web-sdk";
import { connectWallet } from "./openkey.ts";

const HOST = import.meta.env.VITE_TINYCLOUD_HOST || "https://node.tinycloud.xyz";

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
  name: "Feed",
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

/** Sign in via OpenKey passkey, delegating the manifest's `applications`-space
 *  caps to this session, and return the owner's applications-space URI (which
 *  scopes all feed/interactions/media access).
 *
 *  Constructing TinyCloudWeb WITH the OpenKey wallet provider is what makes
 *  `signIn()` run the real SIWE/OpenKey delegation over `MANIFEST` — without a
 *  provider the SDK has no signer and falls into session-only mode (can't reach
 *  the applications space). */
export async function signIn(): Promise<{ appsSpaceUri: string; readerDid: string }> {
  const { web3Provider } = await connectWallet();
  // Compose the app manifest with the optional agent delegation target so the
  // single SIWE recap covers the app's own caps + the agent's scopes.
  const manifest: Manifest | Manifest[] = AGENT_MANIFEST
    ? [MANIFEST, AGENT_MANIFEST]
    : MANIFEST;
  const config: Config = {
    providers: { web3: { driver: web3Provider } },
    tinycloudHosts: [HOST],
    manifest,
  };
  const t = new TinyCloudWeb(config);
  await t.signIn();
  instance = t;
  const appsSpaceUri = t.space("applications").id;
  // Reader DID = the active session principal (contract §1.2: advisory in v1;
  // a trusted writer principal is a server-side upgrade).
  const readerDid = t.did;
  return { appsSpaceUri, readerDid };
}

export async function signOut(): Promise<void> {
  if (instance) {
    await instance.signOut();
    instance = null;
  }
}

export { HOST, AGENT_DID };
