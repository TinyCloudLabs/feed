#!/usr/bin/env bun
// Real-UCAN delegation smoke test: sign in to TinyCloud with a throwaway key,
// mint ONE multi-entry delegation covering the full Feed Host policy via the
// capability-chain flow (delegateTo), submit it to a running Feed Host, and
// verify the host activates every resource.
//
//   FEED_HOST_URL=http://127.0.0.1:8787 bun scripts/delegation-smoke.ts
//
// Exercises the same code path the web client uses after the single-signature
// sign-in change, without needing a browser or passkey.

import { randomBytes } from "node:crypto";
import { serializeDelegation, TinyCloudNode, type Manifest } from "@tinycloud/node-sdk";
import { isRetryableDelegationConflict } from "../web/src/delegationRetry.ts";

const FEED_HOST_URL = process.env.FEED_HOST_URL || "http://127.0.0.1:8787";
const FEED_WEB_ORIGIN = process.env.FEED_WEB_ORIGIN || "https://feed.tinycloud.xyz";
const TINYCLOUD_HOST = process.env.TINYCLOUD_HOST || process.env.VITE_TINYCLOUD_HOST || undefined;

type PolicyResource = { service: string; path: string; actions: string[] };
type Policy = { delegateDID: string; resources: PolicyResource[] };

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function delegationManifest(policy: Policy): Manifest {
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
    })),
  };
}

const policyResponse = await fetch(new URL("/delegation-policy", FEED_HOST_URL));
if (!policyResponse.ok) {
  log("policy_fetch_failed", { status: policyResponse.status });
  process.exit(1);
}
const policy = (await policyResponse.json()) as Policy;
log("policy_loaded", { delegateDID: policy.delegateDID, resources: policy.resources.length });

const node = new TinyCloudNode({
  privateKey: randomBytes(32).toString("hex"),
  ...(TINYCLOUD_HOST ? { host: TINYCLOUD_HOST } : {}),
  autoCreateSpace: true,
  enablePublicSpace: false,
  includeAccountRegistryPermissions: false,
  manifest: delegationManifest(policy),
});

await node.signIn();
log("signed_in", { did: node.did });

const retryDelaysMs = [1000, 3000, 7000, 12000];
let result: Awaited<ReturnType<typeof node.delegateTo>>;
for (let attempt = 0; ; attempt += 1) {
  try {
    result = await node.delegateTo(
      policy.delegateDID,
      policy.resources.map((resource) => ({
        service: resource.service,
        path: resource.path,
        actions: resource.actions,
        skipPrefix: true,
      })),
    );
    break;
  } catch (error) {
    const delay = retryDelaysMs[attempt];
    if (delay === undefined || !isRetryableDelegationConflict(error)) throw error;
    log("delegation_serialization_retry", { attempt: attempt + 1 });
    await Bun.sleep(delay);
  }
}
log("delegation_minted", {
  prompted: result.prompted,
  path: result.delegation.path,
  resources: (result.delegation as { resources?: unknown[] }).resources?.length,
});

const serialized = serializeDelegation(result.delegation);
const submit = await fetch(new URL("/api/delegations", FEED_HOST_URL), {
  method: "POST",
  headers: { "content-type": "application/json", origin: FEED_WEB_ORIGIN },
  body: JSON.stringify({ serializedDelegation: serialized }),
});
const body = (await submit.json()) as { resources?: string[]; status?: string; error?: { code: string; message: string } };
if (!submit.ok) {
  log("submission_rejected", { status: submit.status, error: body.error });
  process.exit(1);
}
log("submission_accepted", { status: body.status, resources: body.resources?.length, paths: body.resources });

const expected = new Set(policy.resources.map((resource) => resource.path));
const granted = new Set(body.resources ?? []);
const missing = [...expected].filter((path) => !granted.has(path));
if (missing.length > 0 || body.status !== "active") {
  log("smoke_failed", { missing, status: body.status });
  process.exit(1);
}

const setCookie = submit.headers.get("set-cookie") ?? "";
const cookieAttributes = setCookie.toLowerCase();
const secureCookie =
  setCookie.startsWith("__Host-feed_session=") &&
  cookieAttributes.includes("path=/") &&
  cookieAttributes.includes("httponly") &&
  cookieAttributes.includes("secure") &&
  /samesite=(strict|none)/.test(cookieAttributes);
const sessionCookie = setCookie.split(";", 1)[0];
const feed = await fetch(new URL("/feed?limit=1", FEED_HOST_URL), {
  headers: { cookie: sessionCookie, origin: FEED_WEB_ORIGIN },
});
const headerOnly = await fetch(new URL("/feed?limit=1", FEED_HOST_URL), {
  headers: { "x-feed-actor-id": node.did },
});
const browserBoundary =
  secureCookie &&
  feed.ok &&
  feed.headers.get("cache-control") === "private, no-store" &&
  feed.headers.get("access-control-allow-origin") === FEED_WEB_ORIGIN &&
  feed.headers.get("access-control-allow-credentials") === "true" &&
  headerOnly.status === 401;
log("browser_boundary_checked", {
  secureCookie,
  feedStatus: feed.status,
  headerOnlyStatus: headerOnly.status,
});

const cleanup = await fetch(new URL("/api/delegations", FEED_HOST_URL), {
  method: "DELETE",
  headers: { cookie: sessionCookie, origin: FEED_WEB_ORIGIN },
});
log("delegation_cleaned", { status: cleanup.status });

if (!browserBoundary || !cleanup.ok) {
  log("smoke_failed", { browserBoundary, cleanupStatus: cleanup.status });
  process.exit(1);
}
log("smoke_passed", { resources: granted.size });
