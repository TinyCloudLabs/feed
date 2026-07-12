import { FEED_HOST_FEED_SETTINGS_PREFIX, normalizeActorId } from "./delegation.ts";
import { FeedHostError, type FeedHostActorStorage } from "./storage.ts";

export type InputAuthorityState = "active" | "expired" | "revoked" | "unavailable";

export type InputAuthorityLineage = {
  childCid: string;
  host: string;
  space: string;
  path: string;
  actions: string[];
  expiry: string;
  parentCid?: string;
  parentLineage?: string[];
  agentDID: string;
};

export type InspectedInputAuthority = InputAuthorityLineage & {
  actorId: string;
  audienceDID: string;
  revoked?: boolean;
};

export type InputAuthorityInspector = (input: {
  portableDelegation: string;
  expectedAudienceDID: string;
  expectedHost: string;
}) => Promise<InspectedInputAuthority>;

export type InputAuthorityTruthCheck = (input: {
  childCid: string;
}) => Promise<InputAuthorityState>;

export type InputAuthorityRevoker = (input: { childCid: string }) => Promise<boolean>;

export type StoredInputAuthority = InputAuthorityLineage & {
  sourceId: string;
  displayName: string;
  actorId: string;
  portableDelegation: string;
  attachedAt: string;
  revokedAt?: string;
  unavailableAt?: string;
  unavailableReason?: string;
};

export type InputAuthorityView = Omit<StoredInputAuthority, "portableDelegation" | "unavailableReason"> & {
  hasPortableDelegation: true;
  state: InputAuthorityState;
};

const INPUT_AUTHORITY_PREFIX = "input-authorities";
const SOURCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const ALLOWED_ACTIONS = new Set(["tinycloud.sql/read", "tinycloud.kv/get", "tinycloud.kv/list"]);
const REQUEST_FIELDS = new Set(["sourceId", "displayName", "portableDelegation"]);
const FORBIDDEN_CREDENTIAL_FIELD = /(tc1|private.?jwk|private.?key|parent.?bearer|raw.?credential|authorization|secret)/i;
const CHILD_FIELDS = new Set([
  "cid", "delegateDID", "delegatorDID", "spaceId", "path", "actions", "expiry", "isRevoked",
  "allowSubDelegation", "parentCid", "createdAt", "delegationHeader", "ownerAddress", "chainId", "host",
  "resources", "disableSubDelegation",
]);
const CHILD_HEADER_FIELDS = new Set(["Authorization"]);
const CHILD_RESOURCE_FIELDS = new Set(["service", "space", "path", "actions"]);

export class InputAuthorityRegistry {
  constructor(private readonly now: () => Date = () => new Date()) {}

  async attach(input: {
    actor: FeedHostActorStorage;
    body: unknown;
    expectedAudienceDID: string;
    expectedHost: string;
    inspect: InputAuthorityInspector;
  }): Promise<InputAuthorityView> {
    const request = validateAttachBody(input.body);
    const inspected = await input.inspect({
      portableDelegation: request.portableDelegation,
      expectedAudienceDID: input.expectedAudienceDID,
      expectedHost: input.expectedHost,
    });
    validateInspection(inspected, {
      actorId: input.actor.actorId,
      expectedAudienceDID: input.expectedAudienceDID,
      expectedHost: input.expectedHost,
      now: this.now(),
    });
    if (inspected.childCid !== request.childCid) throw invalidInspection();
    const records = await this.read(input.actor);
    if (records.some((record) => record.sourceId === request.sourceId)) {
      throw new FeedHostError("input authority sourceId already exists", 409, "input_authority_conflict");
    }
    const record: StoredInputAuthority = {
      sourceId: request.sourceId,
      displayName: request.displayName,
      actorId: normalizeActorId(input.actor.actorId),
      portableDelegation: request.portableDelegation,
      childCid: inspected.childCid,
      host: normalizeHost(inspected.host),
      space: inspected.space,
      path: inspected.path,
      actions: [...inspected.actions],
      expiry: inspected.expiry,
      ...(inspected.parentCid ? { parentCid: inspected.parentCid } : {}),
      ...(inspected.parentLineage ? { parentLineage: [...inspected.parentLineage] } : {}),
      agentDID: inspected.agentDID,
      attachedAt: this.now().toISOString(),
    };
    await this.write(input.actor, [...records, record]);
    return toView(record, this.now(), "active");
  }

  async list(actor: FeedHostActorStorage, check?: InputAuthorityTruthCheck): Promise<InputAuthorityView[]> {
    const views: InputAuthorityView[] = [];
    for (const record of await this.read(actor)) views.push(await this.refresh(record, actor, check));
    return views;
  }

  async get(actor: FeedHostActorStorage, sourceId: string, check?: InputAuthorityTruthCheck): Promise<InputAuthorityView> {
    return this.refresh(await this.requireRecord(actor, sourceId), actor, check);
  }

  async revoke(actor: FeedHostActorStorage, sourceId: string, revoke: InputAuthorityRevoker): Promise<InputAuthorityView> {
    const records = await this.read(actor);
    const index = records.findIndex((record) => record.sourceId === sourceId);
    if (index < 0) throw new FeedHostError("input authority not found", 404, "not_found");
    const confirmed = await revoke({ childCid: records[index]!.childCid }).catch(() => false);
    if (!confirmed) {
      throw new FeedHostError("input authority revocation was not confirmed by TinyCloud", 502, "input_authority_unavailable");
    }
    const next = { ...records[index]!, revokedAt: this.now().toISOString() };
    records[index] = next;
    await this.write(actor, records);
    return toView(next, this.now());
  }

  async remove(actor: FeedHostActorStorage, sourceId: string): Promise<void> {
    const records = await this.read(actor);
    const remaining = records.filter((record) => record.sourceId !== sourceId);
    if (remaining.length === records.length) throw new FeedHostError("input authority not found", 404, "not_found");
    await this.write(actor, remaining);
  }

  async markUnavailable(actor: FeedHostActorStorage, sourceId: string, reason: string): Promise<InputAuthorityView> {
    const records = await this.read(actor);
    const index = records.findIndex((record) => record.sourceId === sourceId);
    if (index < 0) throw new FeedHostError("input authority not found", 404, "not_found");
    const next = {
      ...records[index]!,
      unavailableAt: this.now().toISOString(),
      unavailableReason: reason.slice(0, 240),
    };
    records[index] = next;
    await this.write(actor, records);
    return toView(next, this.now());
  }

  private async requireRecord(actor: FeedHostActorStorage, sourceId: string): Promise<StoredInputAuthority> {
    const record = (await this.read(actor)).find((candidate) => candidate.sourceId === sourceId);
    if (!record) throw new FeedHostError("input authority not found", 404, "not_found");
    return record;
  }

  private async refresh(
    record: StoredInputAuthority,
    actor: FeedHostActorStorage,
    check?: InputAuthorityTruthCheck,
  ): Promise<InputAuthorityView> {
    if (record.revokedAt) return toView(record, this.now(), "revoked");
    if (Date.parse(record.expiry) <= this.now().getTime()) return toView(record, this.now(), "expired");
    if (!check) return toView(record, this.now(), "unavailable");
    const state = await check({ childCid: record.childCid }).catch(() => "unavailable" as const);
    if (state === "revoked") {
      const next = { ...record, revokedAt: this.now().toISOString() };
      await this.replace(actor, next);
      return toView(next, this.now(), "revoked");
    }
    if (state === "unavailable") {
      const next = { ...record, unavailableAt: this.now().toISOString(), unavailableReason: "TinyCloud status unavailable" };
      await this.replace(actor, next);
      return toView(next, this.now(), "unavailable");
    }
    if (state === "expired") return toView(record, this.now(), "expired");
    if (record.unavailableAt) {
      const { unavailableAt: _unavailableAt, unavailableReason: _unavailableReason, ...available } = record;
      await this.replace(actor, available);
      return toView(available, this.now(), "active");
    }
    return toView(record, this.now(), "active");
  }

  private async replace(actor: FeedHostActorStorage, next: StoredInputAuthority): Promise<void> {
    const records = await this.read(actor);
    const index = records.findIndex((record) => record.sourceId === next.sourceId);
    if (index < 0) return;
    records[index] = next;
    await this.write(actor, records);
  }

  private async read(actor: FeedHostActorStorage): Promise<StoredInputAuthority[]> {
    const result = await actor.settings.kv.get<StoredInputAuthority[] | string>(keyFor(actor.actorId));
    if (!result.ok) {
      if (isNotFound(result.error)) return [];
      throw new FeedHostError("input authority storage read failed", 500, "internal_error");
    }
    try {
      const value = typeof result.data.data === "string" ? JSON.parse(result.data.data) : result.data.data;
      return Array.isArray(value)
        ? value.filter((record): record is StoredInputAuthority => validStoredRecord(record, actor.actorId))
        : [];
    } catch {
      throw new FeedHostError("input authority storage is malformed", 500, "internal_error");
    }
  }

  private async write(actor: FeedHostActorStorage, records: StoredInputAuthority[]): Promise<void> {
    const result = await actor.settings.kv.put(keyFor(actor.actorId), records, { contentType: "application/json" });
    if (!result.ok) throw new FeedHostError("input authority storage write failed", 500, "internal_error");
  }
}

function isNotFound(error: { code?: unknown; message?: unknown }): boolean {
  return /(?:not[_ -]?found|\b404\b)/i.test(`${String(error.code ?? "")} ${String(error.message ?? "")}`);
}

export function validateAttachBody(value: unknown): {
  sourceId: string;
  displayName: string;
  portableDelegation: string;
  childCid: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeedHostError("input authority body must be an object", 400, "invalid_input_authority");
  }
  const record = value as Record<string, unknown>;
  const forbidden = Object.keys(record).find((key) => FORBIDDEN_CREDENTIAL_FIELD.test(key));
  if (forbidden || Object.keys(record).some((key) => !REQUEST_FIELDS.has(key))) {
    throw new FeedHostError("input authority body contains unsupported credential fields", 400, "invalid_input_authority");
  }
  const sourceId = typeof record.sourceId === "string" ? record.sourceId.trim() : "";
  const displayName = typeof record.displayName === "string" ? record.displayName.trim() : "";
  const portableDelegation = typeof record.portableDelegation === "string" ? record.portableDelegation.trim() : "";
  if (!SOURCE_ID.test(sourceId)) throw new FeedHostError("sourceId is invalid", 400, "invalid_input_authority");
  if (!displayName || displayName.length > 100) throw new FeedHostError("displayName is invalid", 400, "invalid_input_authority");
  if (!portableDelegation || portableDelegation.length > 65_536 || portableDelegation.startsWith("tc1:")) {
    throw new FeedHostError("a child portable delegation is required", 400, "invalid_input_authority");
  }
  const childCid = validateTerminalChildTransport(portableDelegation);
  return { sourceId, displayName, portableDelegation, childCid };
}

function validateTerminalChildTransport(serialized: string): string {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw invalidTransport();
  }
  if (!isPlainRecord(value) || !hasExactKeys(value, CHILD_FIELDS)) throw invalidTransport();
  const header = value.delegationHeader;
  const resources = value.resources;
  if (
    !nonEmptyString(value.cid) || !nonEmptyString(value.delegateDID) || !nonEmptyString(value.delegatorDID) ||
    !nonEmptyString(value.spaceId) || !nonEmptyString(value.path) || !stringArray(value.actions) ||
    !nonEmptyString(value.expiry) || value.isRevoked !== false || value.allowSubDelegation !== false ||
    !nonEmptyString(value.parentCid) || !nonEmptyString(value.createdAt) ||
    !nonEmptyString(value.ownerAddress) || typeof value.chainId !== "number" || !Number.isInteger(value.chainId) ||
    !nonEmptyString(value.host) || value.disableSubDelegation !== true ||
    !isPlainRecord(header) || !hasExactKeys(header, CHILD_HEADER_FIELDS) || !nonEmptyString(header.Authorization) ||
    !Array.isArray(resources) || resources.length === 0 || !resources.every(validChildResource)
  ) {
    throw invalidTransport();
  }
  return value.cid;
}

function validChildResource(value: unknown): boolean {
  return isPlainRecord(value) && hasExactKeys(value, CHILD_RESOURCE_FIELDS) &&
    nonEmptyString(value.service) && nonEmptyString(value.space) && nonEmptyString(value.path) && stringArray(value.actions);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);
}

function invalidTransport(): FeedHostError {
  return new FeedHostError("a terminal child portable delegation is required", 400, "invalid_input_authority");
}

export function validateInspection(
  value: InspectedInputAuthority,
  expected: { actorId: string; expectedAudienceDID: string; expectedHost: string; now: Date },
): void {
  if (!value || typeof value !== "object") throw invalidInspection();
  if (normalizeActorId(value.actorId) !== normalizeActorId(expected.actorId)) {
    throw new FeedHostError("input authority owner does not match actor", 403, "actor_mismatch");
  }
  if (value.audienceDID !== expected.expectedAudienceDID || value.agentDID !== expected.expectedAudienceDID) {
    throw new FeedHostError("input authority audience does not match Feed Host", 403, "wrong_audience");
  }
  if (normalizeHost(value.host) !== normalizeHost(expected.expectedHost)) {
    throw new FeedHostError("input authority host is not allowlisted", 403, "wrong_host");
  }
  if (!/^tinycloud:pkh:eip155:\d+:0x[a-fA-F0-9]{40}:applications$/.test(value.space)) {
    throw new FeedHostError("input authority space is not allowlisted", 403, "broad_permissions");
  }
  if (!isAllowedTranscriptGrant(value.path, value.actions)) {
    throw new FeedHostError("input authority permissions are broader than transcript read", 403, "broad_permissions");
  }
  if (
    typeof value.parentCid !== "string" || !value.parentCid.trim() ||
    !Array.isArray(value.parentLineage) || value.parentLineage.length === 0 ||
    value.parentLineage.some((cid) => typeof cid !== "string" || !cid.trim())
  ) {
    throw new FeedHostError("input authority parent lineage is missing", 400, "invalid_input_authority");
  }
  if (value.revoked) throw new FeedHostError("input authority is revoked", 409, "input_authority_revoked");
  const expiry = Date.parse(value.expiry);
  if (!Number.isFinite(expiry) || expiry <= expected.now.getTime()) {
    throw new FeedHostError("input authority is expired", 409, "input_authority_expired");
  }
}

function toView(record: StoredInputAuthority, now: Date, confirmedState?: InputAuthorityState): InputAuthorityView {
  const { portableDelegation: _portableDelegation, unavailableReason: _unavailableReason, ...safe } = record;
  const state: InputAuthorityState = confirmedState ?? (record.revokedAt
    ? "revoked"
    : Date.parse(record.expiry) <= now.getTime()
      ? "expired"
      : record.unavailableAt
        ? "unavailable"
        : "unavailable");
  return { ...safe, hasPortableDelegation: true, state };
}

function keyFor(actorId: string): string {
  const normalized = normalizeActorId(actorId);
  if (!normalized || normalized.includes("/") || normalized.includes("\\") || normalized.includes("..")) {
    throw new FeedHostError("actor id is invalid", 400, "actor_mismatch");
  }
  return `${FEED_HOST_FEED_SETTINGS_PREFIX}/${INPUT_AUTHORITY_PREFIX}/${encodeURIComponent(normalized)}.json`;
}

function validStoredRecord(value: unknown, actorId: string): value is StoredInputAuthority {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<StoredInputAuthority>;
  return (
    typeof record.sourceId === "string" && SOURCE_ID.test(record.sourceId) &&
    typeof record.displayName === "string" &&
    typeof record.actorId === "string" && normalizeActorId(record.actorId) === normalizeActorId(actorId) &&
    typeof record.portableDelegation === "string" && record.portableDelegation.length <= 65_536 && terminalChildCid(record.portableDelegation) === record.childCid &&
    typeof record.childCid === "string" && record.childCid.length > 0 &&
    typeof record.host === "string" && typeof record.space === "string" &&
    typeof record.path === "string" && Array.isArray(record.actions) && isAllowedTranscriptGrant(record.path, record.actions) &&
    typeof record.expiry === "string" && typeof record.parentCid === "string" && record.parentCid.length > 0 &&
    Array.isArray(record.parentLineage) && record.parentLineage.length > 0 && record.parentLineage.every((cid) => typeof cid === "string") &&
    typeof record.agentDID === "string" && typeof record.attachedAt === "string"
  );
}

function terminalChildCid(serialized: string): string | null {
  try {
    return validateTerminalChildTransport(serialized);
  } catch {
    return null;
  }
}

function isAllowedTranscriptGrant(path: string, actions: unknown[]): actions is string[] {
  if (actions.length === 0 || actions.some((action) => typeof action !== "string" || !ALLOWED_ACTIONS.has(action))) return false;
  if (path === "xyz.tinycloud.listen/conversations") return actions.every((action) => action === "tinycloud.sql/read");
  if (path.startsWith("xyz.tinycloud.listen/transcript/") && path.length > "xyz.tinycloud.listen/transcript/".length) {
    return actions.every((action) => action === "tinycloud.kv/get" || action === "tinycloud.kv/list");
  }
  return false;
}

function normalizeHost(host: string): string {
  try {
    const url = new URL(host);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return "invalid-host";
  }
}

function invalidInspection(): FeedHostError {
  return new FeedHostError("input authority inspection failed", 400, "invalid_input_authority");
}
