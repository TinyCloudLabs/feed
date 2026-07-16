import { createHash } from "node:crypto";
import type { DelegatedAccess, IDatabaseHandle, TinyCloudNode } from "@tinycloud/node-sdk";
import {
  activateFeedHostDelegation,
  actorIdsMatch,
  createFeedHostNode,
  FEED_HOST_ARTIFACT_DOC_PREFIX,
  FEED_HOST_ARTIFACTS_DB_PATH,
  FEED_HOST_FEED_DB_PATH,
  FEED_HOST_FEED_SETTINGS_PREFIX,
} from "../host/delegation.ts";
import { FeedHostDelegationStore, liveDelegationResources } from "../host/delegation-store.ts";
import { ensureFeedHostPrivateKey } from "../host/host-key.ts";
import { FeedHostStorage, type FeedHostActorStorage } from "../host/storage.ts";

export const ARTIFACT_DOC_NAMESPACE = FEED_HOST_ARTIFACT_DOC_PREFIX.replace(/\/$/, "");

type RepairResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code?: string; message?: string } };

export type RepairKv = {
  list(options: { prefix: string; removePrefix?: boolean }): Promise<RepairResult<{ keys: string[] }>>;
  get(key: string, options?: { raw?: boolean }): Promise<RepairResult<{ data: unknown }>>;
  put(key: string, value: string, options?: { contentType?: string }): Promise<RepairResult<unknown>>;
};

export type RepairArtifactIndexRow = {
  artifactId: string;
  docKey: string;
};

export type RepairArtifactIndex = {
  findByArtifactId(artifactId: string): Promise<RepairArtifactIndexRow | null>;
  normalizeDocKey(artifactId: string, expectedDocKey: string, relativeDocKey: string): Promise<number>;
};

export type RepairSummary = {
  candidates: number;
  verified: number;
  alreadyRepaired: number;
  written: number;
  normalized: number;
  refused: number;
  invalid: number;
  dryRun: boolean;
};

export async function repairDoublePrefixedDocs(input: {
  kv: RepairKv;
  index: RepairArtifactIndex;
  dryRun?: boolean;
  log?: (message: string) => void;
}): Promise<RepairSummary> {
  const log = input.log ?? console.log;
  // Safe by default even when called as a library; live mutation requires an
  // explicit dryRun:false from the FEED_REPAIR_EXECUTE-gated CLI path.
  const dryRun = input.dryRun !== false;
  const listPrefix = `${ARTIFACT_DOC_NAMESPACE}/`;
  const listed = await input.kv.list({ prefix: listPrefix, removePrefix: false });
  if (!listed.ok) throw new Error(`Could not list artifact documents: ${repairError(listed)}`);

  const doubledPrefix = `${ARTIFACT_DOC_NAMESPACE}/${ARTIFACT_DOC_NAMESPACE}/`;
  // TinyCloud returns full physical keys with removePrefix=false. Some live
  // listings repeat keys, so collapse duplicates before probing or writing.
  const candidates = [...new Set(listed.data.keys)]
    .filter((key) => key.startsWith(doubledPrefix))
    .sort();
  const summary: RepairSummary = {
    candidates: candidates.length,
    verified: 0,
    alreadyRepaired: 0,
    written: 0,
    normalized: 0,
    refused: 0,
    invalid: 0,
    dryRun,
  };
  log(`Found ${candidates.length} double-prefixed artifact document(s).`);
  if (candidates.length === 0) return summary;

  const firstPhysicalKey = candidates[0]!;
  const firstRaw = await probeFullPhysicalKey(input.kv, firstPhysicalKey);
  log(`Verified delegated KV full-physical GET: ${firstPhysicalKey}`);

  for (const physicalKey of candidates) {
    const source = physicalKey === firstPhysicalKey ? firstRaw : await readRequiredRaw(input.kv, physicalKey);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      summary.invalid += 1;
      log(`INVALID ${physicalKey}: document is not valid JSON; skipped.`);
      continue;
    }
    const artifactId = artifactIdFromDocument(parsed);
    if (!artifactId) {
      summary.invalid += 1;
      log(`INVALID ${physicalKey}: document has no artifactId; skipped.`);
      continue;
    }
    const indexRow = await input.index.findByArtifactId(artifactId);
    if (!indexRow || indexRow.artifactId !== artifactId) {
      summary.invalid += 1;
      log(`INVALID ${physicalKey}: artifactId ${artifactId} has no matching artifact_index row; skipped.`);
      continue;
    }

    const relativeTargetKey = relativeArtifactDocKey(indexRow.docKey);
    const sourceRelativeKey = physicalKey.slice(doubledPrefix.length);
    if (sourceRelativeKey !== relativeTargetKey) {
      summary.invalid += 1;
      log(`INVALID ${physicalKey}: key-derived target ${sourceRelativeKey} does not match artifact_index target ${relativeTargetKey} for ${artifactId}; skipped.`);
      continue;
    }
    const targetPhysicalKey = `${ARTIFACT_DOC_NAMESPACE}/${relativeTargetKey}`;
    const sourceHash = sha256(source);
    const target = await readOptionalRaw(input.kv, targetPhysicalKey);
    if (target !== null && sha256(target) !== sourceHash) {
      summary.refused += 1;
      log(`REFUSED ${artifactId}: target ${targetPhysicalKey} exists with different sha256; source=${sourceHash} target=${sha256(target)}.`);
      continue;
    }

    if (target === null) {
      if (dryRun) {
        log(`DRY RUN ${artifactId}: would write ${targetPhysicalKey}, read it back, and verify sha256=${sourceHash}.`);
      } else {
        const put = await input.kv.put(targetPhysicalKey, source, { contentType: "application/json" });
        if (!put.ok) throw new Error(`Could not write ${targetPhysicalKey}: ${repairError(put)}`);
        summary.written += 1;
        const readBack = await readRequiredRaw(input.kv, targetPhysicalKey);
        const readBackHash = sha256(readBack);
        if (readBack !== source || readBackHash !== sourceHash) {
          throw new Error(`Verification failed for ${artifactId}: source=${sourceHash} target=${readBackHash}`);
        }
        log(`VERIFIED ${artifactId}: wrote and read back ${targetPhysicalKey}; sha256=${sourceHash}.`);
      }
    } else {
      summary.alreadyRepaired += 1;
      log(`${dryRun ? "DRY RUN " : ""}ALREADY REPAIRED ${artifactId}: target ${targetPhysicalKey} matches sha256=${sourceHash}; skipping write.`);
    }

    summary.verified += 1;
    if (isAbsoluteArtifactDocKey(indexRow.docKey)) {
      if (dryRun) {
        log(`DRY RUN ${artifactId}: would normalize artifact_index.doc_key from ${indexRow.docKey} to ${relativeTargetKey}.`);
      } else {
        const changes = await input.index.normalizeDocKey(artifactId, indexRow.docKey, relativeTargetKey);
        if (changes === 0) {
          log(`NORMALIZE SKIPPED ${artifactId}: artifact_index row no longer matched ${indexRow.docKey}; no rows changed.`);
        } else if (changes === 1) {
          summary.normalized += 1;
          log(`NORMALIZED ${artifactId}: artifact_index.doc_key=${relativeTargetKey}.`);
        } else {
          throw new Error(`Normalization changed ${changes} artifact_index rows for ${artifactId}; expected at most one`);
        }
      }
    }
  }

  log("Double-prefixed originals were retained for rollback safety.");
  return summary;
}

export function createLiveArtifactIndex(access: DelegatedAccess): RepairArtifactIndex {
  const db = access.sql.db(FEED_HOST_ARTIFACTS_DB_PATH);
  return {
    async findByArtifactId(artifactId) {
      const rows = await queryRows<{ artifact_id: string; doc_key: string }>(
        db,
        "SELECT artifact_id, doc_key FROM artifact_index WHERE artifact_id = ? LIMIT 1",
        [artifactId],
      );
      const row = rows[0];
      return row ? { artifactId: row.artifact_id, docKey: row.doc_key } : null;
    },
    async normalizeDocKey(artifactId, expectedDocKey, relativeDocKey) {
      const result = await db.execute(
        "UPDATE artifact_index SET doc_key = ? WHERE artifact_id = ? AND doc_key = ?",
        [relativeDocKey, artifactId, expectedDocKey],
      );
      if (!result.ok) throw new Error(`Could not normalize artifact_index for ${artifactId}: ${repairError(result)}`);
      return Number(result.data?.changes ?? 0);
    },
  };
}

async function probeFullPhysicalKey(
  kv: RepairKv,
  physicalKey: string,
): Promise<string> {
  const result = await kv.get(physicalKey, { raw: true });
  if (result.ok) return rawString(result.data.data, physicalKey);
  throw new Error(
    `Full-physical KV startup probe failed for listed key ${physicalKey}; aborting repair: ${repairError(result)}`,
  );
}

async function readOptionalRaw(kv: RepairKv, key: string): Promise<string | null> {
  const result = await kv.get(key, { raw: true });
  if (result.ok) return rawString(result.data.data, key);
  if (isNotFound(result)) return null;
  throw new Error(`Could not read ${key}: ${repairError(result)}`);
}

async function readRequiredRaw(kv: RepairKv, key: string): Promise<string> {
  const value = await readOptionalRaw(kv, key);
  if (value === null) throw new Error(`Expected artifact document is missing: ${key}`);
  return value;
}

function relativeArtifactDocKey(docKey: string): string {
  let relative = docKey.replace(/^\/+/, "");
  const prefix = `${ARTIFACT_DOC_NAMESPACE}/`;
  while (relative.startsWith(prefix)) relative = relative.slice(prefix.length);
  if (!relative || relative.includes("..")) throw new Error(`Unsafe artifact doc key: ${docKey}`);
  return relative;
}

function isAbsoluteArtifactDocKey(docKey: string): boolean {
  return docKey.replace(/^\/+/, "").startsWith(`${ARTIFACT_DOC_NAMESPACE}/`);
}

function artifactIdFromDocument(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const artifactId = (value as { artifactId?: unknown }).artifactId;
  return typeof artifactId === "string" && artifactId.trim() ? artifactId : null;
}

function rawString(value: unknown, key: string): string {
  if (typeof value !== "string") throw new Error(`Raw KV read for ${key} did not return bytes as text`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNotFound(result: RepairResult<unknown>): boolean {
  return !result.ok && (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND");
}

function repairError(result: { error?: { code?: string; message?: string } }): string {
  return result.error?.message ?? result.error?.code ?? "unknown TinyCloud error";
}

async function queryRows<T extends Record<string, unknown>>(
  db: IDatabaseHandle,
  sql: string,
  params: string[],
): Promise<T[]> {
  const result = await db.query<T>(sql, params);
  if (!result.ok) throw new Error(`TinyCloud SQL query failed: ${repairError(result)}`);
  return result.data.rows.map((row) => {
    if (!Array.isArray(row)) return row as T;
    return Object.fromEntries(result.data.columns.map((column, index) => [column, row[index]])) as T;
  });
}

async function activateActor(stateDir: string, actorId: string): Promise<{
  node: TinyCloudNode;
  actor: FeedHostActorStorage;
  documents: DelegatedAccess;
}> {
  const privateKey = ensureFeedHostPrivateKey(stateDir);
  const node = createFeedHostNode({
    privateKey,
    host: process.env.TINYCLOUD_HOST || process.env.VITE_TINYCLOUD_HOST || undefined,
  });
  await node.signIn();
  const store = new FeedHostDelegationStore(node);
  const stored = await store.load(actorId);
  if (!stored || !actorIdsMatch(stored.actorId, actorId)) {
    throw new Error(`No stored Feed Host delegations found for ${actorId}`);
  }
  const live = liveDelegationResources(stored);
  if (live.length === 0) throw new Error(`Stored Feed Host delegations are expired for ${actorId}`);
  const accessByResource = new Map<string, DelegatedAccess>();
  const unique = [...new Set(live.map((resource) => resource.serializedDelegation))];
  for (const serializedDelegation of unique) {
    const activated = await activateFeedHostDelegation({
      node,
      serializedDelegation,
      expectedDelegateDID: stored.delegateDID,
    });
    if (!actorIdsMatch(activated.actorId, actorId)) {
      throw new Error(`Stored delegation actor ${activated.actorId} does not match FEED_REPAIR_ACTOR`);
    }
    for (const resource of activated.resources) accessByResource.set(resource, activated.access);
  }
  const artifacts = requiredAccess(accessByResource, FEED_HOST_ARTIFACTS_DB_PATH);
  const feed = requiredAccess(accessByResource, FEED_HOST_FEED_DB_PATH);
  const settings = requiredAccess(accessByResource, FEED_HOST_FEED_SETTINGS_PREFIX);
  const documents = requiredAccess(accessByResource, FEED_HOST_ARTIFACT_DOC_PREFIX);
  return {
    node,
    documents,
    actor: { actorId, artifacts, feed, settings, documents },
  };
}

function requiredAccess(resources: Map<string, DelegatedAccess>, path: string): DelegatedAccess {
  const access = resources.get(path);
  if (!access) throw new Error(`Stored delegations do not activate required resource: ${path}`);
  return access;
}

async function main(): Promise<void> {
  const stateDir = process.env.FEED_HOST_STATE_DIR?.trim();
  const actorId = process.env.FEED_REPAIR_ACTOR?.trim();
  if (!stateDir) throw new Error("FEED_HOST_STATE_DIR is required");
  if (!actorId || !actorId.startsWith("did:")) throw new Error("FEED_REPAIR_ACTOR must be a DID");
  const execute = process.env.FEED_REPAIR_EXECUTE === "1";
  const dryRun = !execute;
  const activated = await activateActor(stateDir, actorId);
  const summary = await repairDoublePrefixedDocs({
    kv: activated.documents.kv as unknown as RepairKv,
    index: createLiveArtifactIndex(activated.actor.artifacts),
    dryRun,
  });
  console.log(`Repair summary: ${JSON.stringify(summary)}`);
  if (dryRun) {
    console.log("Dry run complete. Set FEED_REPAIR_EXECUTE=1 explicitly to write and reconcile.");
    return;
  }
  console.log("Running feed projection reconciliation so repaired integrity state can clear quarantine.");
  const plan = await new FeedHostStorage().reconcileFeedProjection(activated.actor);
  console.log(`Reconciliation complete: ${plan.upserts.length} upsert(s), ${plan.deletions.length} deletion(s).`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
