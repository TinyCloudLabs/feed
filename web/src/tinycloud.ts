// tinycloud.ts — browser web-SDK session for the viewer.
//
// V1 signs in as the space OWNER (full access to its own `applications` space;
// the scoped-reader delegation of contract §3.5 is a later iteration). The
// manifest requests `applications`-space SQL + KV caps so the owner session
// actually carries capabilities reaching `xyz.tinycloud.artifacts/feed`,
// `/interactions`, and `/media/`.

import { TinyCloudWeb, type Config, type Manifest } from "@tinycloud/web-sdk";

const HOST = "https://node.tinycloud.xyz";

/** The artifacts app namespace (contract: xyz.tinycloud.artifacts). */
export const ARTIFACTS_APP_ID = "xyz.tinycloud.artifacts";

/** Contract §1 DB paths (within the applications space). */
export const FEED_DB = "xyz.tinycloud.artifacts/feed";
export const INTERACTIONS_DB = "xyz.tinycloud.artifacts/interactions";
/** Contract §2 media KV prefix (trailing slash = prefix semantics). */
export const MEDIA_PREFIX = "xyz.tinycloud.artifacts/media/";

// Manifest: declare exactly the caps the viewer needs on the applications
// space. `prefix: ""` disables the auto app-id prefix so our full contract
// paths are used verbatim (otherwise the SDK would prepend `xyz.tinycloud.artifacts`).
const MANIFEST: Manifest = {
  app_id: ARTIFACTS_APP_ID,
  name: "Feed",
  description: "Reads the artifact feed and records reader interactions.",
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
      path: "xyz.tinycloud.artifacts/",
      actions: ["get", "list", "metadata"],
      description: "Read artifact media (hero images, audio).",
    },
  ],
};

let instance: TinyCloudWeb | null = null;

/** Lazily construct the singleton TinyCloudWeb with the artifacts manifest. */
export function tcw(): TinyCloudWeb {
  if (!instance) {
    const config: Config = { manifest: MANIFEST };
    instance = new TinyCloudWeb(config);
  }
  return instance;
}

/** Sign in (OpenKey/passkey via the configured provider) and return the owner's
 *  applications-space URI, which scopes all feed/interactions/media access. */
export async function signIn(): Promise<{ appsSpaceUri: string; readerDid: string }> {
  const t = tcw();
  await t.signIn();
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

export { HOST };
