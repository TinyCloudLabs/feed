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

const FEED_HOST_URL = process.env.FEED_HOST_URL || "http://127.0.0.1:8787";
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

const result = await node.delegateTo(
  policy.delegateDID,
  policy.resources.map((resource) => ({
    service: resource.service,
    path: resource.path,
    actions: resource.actions,
    skipPrefix: true,
  })),
);
log("delegation_minted", {
  prompted: result.prompted,
  path: result.delegation.path,
  resources: (result.delegation as { resources?: unknown[] }).resources?.length,
});

const serialized = serializeDelegation(result.delegation);
const submit = await fetch(new URL("/api/delegations", FEED_HOST_URL), {
  method: "POST",
  headers: { "content-type": "application/json" },
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
log("smoke_passed", { resources: granted.size });
