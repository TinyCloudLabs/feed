import type { TinyCloudNode } from "@tinycloud/node-sdk";
import { normalizeActorId } from "./delegation.ts";

export type StoredFeedDelegationResource = {
  path: string;
  serializedDelegation: string;
  acceptedAt: string;
  expiresAt: string;
};

export type StoredFeedDelegationRecord = {
  actorId: string;
  delegateDID: string;
  resources: StoredFeedDelegationResource[];
};

/**
 * Persists accepted Feed Host delegations in the host's own TinyCloud KV
 * space so accepted actors survive restarts (same pattern as the Listen
 * backend delegation store). Only meaningful with a stable host identity
 * (FEED_HOST_PRIVATE_KEY): a generated session DID cannot reactivate
 * delegations minted for a previous DID.
 */
export class FeedHostDelegationStore {
  private session: Promise<unknown> | null = null;

  constructor(private readonly node: TinyCloudNode) {}

  async save(record: StoredFeedDelegationRecord): Promise<void> {
    await this.ensureSignedIn();
    const result = await this.node.kv.put(keyFor(record.actorId), record, {
      contentType: "application/json",
    });
    if (!result.ok) {
      throw new Error(`Failed to persist delegations for ${record.actorId}: ${kvError(result)}`);
    }
  }

  async load(actorId: string): Promise<StoredFeedDelegationRecord | null> {
    await this.ensureSignedIn();
    const result = await this.node.kv.get<StoredFeedDelegationRecord | string>(keyFor(actorId));
    if (!result.ok) {
      if (result.error.code === "KV_NOT_FOUND" || result.error.code === "NOT_FOUND") return null;
      throw new Error(`Failed to load delegations for ${actorId}: ${kvError(result)}`);
    }
    const raw = typeof result.data.data === "string" ? JSON.parse(result.data.data) : result.data.data;
    return isStoredRecord(raw) ? raw : null;
  }

  async remove(actorId: string): Promise<void> {
    await this.ensureSignedIn();
    const result = await this.node.kv.delete(keyFor(actorId));
    if (!result.ok && result.error.code !== "KV_NOT_FOUND" && result.error.code !== "NOT_FOUND") {
      throw new Error(`Failed to remove delegations for ${actorId}: ${kvError(result)}`);
    }
  }

  private async ensureSignedIn(): Promise<void> {
    if (!this.session) {
      this.session = this.node.signIn().catch((error) => {
        this.session = null;
        throw error;
      });
    }
    await this.session;
  }
}

export function liveDelegationResources(
  record: StoredFeedDelegationRecord,
  now: Date = new Date(),
): StoredFeedDelegationResource[] {
  return record.resources.filter((resource) => {
    const expiry = Date.parse(resource.expiresAt);
    return Number.isFinite(expiry) && expiry > now.getTime();
  });
}

function keyFor(actorId: string): string {
  if (!actorId || actorId.includes("/") || actorId.includes("\\") || actorId.includes("..")) {
    throw new Error("invalid actor id for delegation store");
  }
  return `delegations/${normalizeActorId(actorId)}`;
}

function isStoredRecord(value: unknown): value is StoredFeedDelegationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StoredFeedDelegationRecord>;
  return (
    typeof record.actorId === "string" &&
    typeof record.delegateDID === "string" &&
    Array.isArray(record.resources) &&
    record.resources.every(
      (resource) =>
        resource !== null &&
        typeof resource === "object" &&
        typeof resource.path === "string" &&
        typeof resource.serializedDelegation === "string" &&
        typeof resource.acceptedAt === "string" &&
        typeof resource.expiresAt === "string",
    )
  );
}

function kvError(result: { error?: { message?: unknown; code?: unknown } }): string {
  if (result.error?.message) return String(result.error.message);
  if (result.error?.code) return String(result.error.code);
  return "TinyCloud KV operation failed";
}
