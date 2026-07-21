import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { logEvent } from "./log.ts";

export type StorageSpanOp =
  | "artifact_index_lookup"
  | "artifact_document_get"
  | "artifact_inline_media_decode"
  | "artifact_media_get"
  | "preference_get"
  | "preference_put"
  | "seed_doc_write";

export type StorageResultCode = "ok" | "not_found" | "unauthorized" | `error:${string}`;

type StorageOperationState = { healed: boolean };
const storageOperation = new AsyncLocalStorage<StorageOperationState>();
const requestTrace = new AsyncLocalStorage<string | undefined>();

/** Privacy boundary for telemetry identifiers. Never emit an actor/artifact ID directly. */
export function telemetryIdHash(value: string): string {
  const stableValue = typeof value === "string" && value.length > 0 ? value : "unknown";
  return createHash("sha256").update(stableValue).digest("hex").slice(0, 12);
}

export function markCurrentStorageOperationHealed(): void {
  const state = storageOperation.getStore();
  if (state) state.healed = true;
}

export function withTelemetryTrace<T>(traceId: string | undefined, run: () => T): T {
  return requestTrace.run(traceId, run);
}

export async function withStorageSpan<T>(input: {
  op: StorageSpanOp;
  actorId: string;
  artifactId?: string;
  resourcePath: string;
  traceId?: string;
  run: () => Promise<T>;
  resultCode: (value: T) => StorageResultCode;
}): Promise<T> {
  const startedAt = performance.now();
  const state: StorageOperationState = { healed: false };
  try {
    const value = await storageOperation.run(state, input.run);
    emitStorageSpan(input, startedAt, state.healed, input.resultCode(value));
    return value;
  } catch (error) {
    emitStorageSpan(input, startedAt, state.healed, storageErrorResultCode(error));
    throw error;
  }
}

export function resultCodeForServiceResult(result: unknown): StorageResultCode {
  if (!result || typeof result !== "object") return "error:invalid_result";
  const serviceResult = result as { ok?: boolean; error?: { code?: unknown; message?: unknown } };
  if (serviceResult.ok === true) return "ok";
  const code = typeof serviceResult.error?.code === "string" ? serviceResult.error.code : "unknown";
  const message = typeof serviceResult.error?.message === "string" ? serviceResult.error.message : "";
  if (code === "KV_NOT_FOUND" || code === "NOT_FOUND") return "not_found";
  if (code === "AUTH_UNAUTHORIZED" || /unauthorized action/i.test(message)) return "unauthorized";
  return `error:${safeErrorCode(code)}`;
}

export function storageErrorResultCode(error: unknown): StorageResultCode {
  const record = error && typeof error === "object"
    ? error as { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } }
    : undefined;
  const code = typeof record?.code === "string"
    ? record.code
    : typeof record?.error?.code === "string"
      ? record.error.code
      : "unknown";
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : typeof record?.error?.message === "string"
        ? record.error.message
        : "";
  if (code === "AUTH_UNAUTHORIZED" || /unauthorized action/i.test(message)) return "unauthorized";
  if (code === "KV_NOT_FOUND" || code === "NOT_FOUND") return "not_found";
  return `error:${safeErrorCode(code)}`;
}

function emitStorageSpan(
  input: Pick<Parameters<typeof withStorageSpan>[0], "op" | "actorId" | "artifactId" | "resourcePath" | "traceId">,
  startedAt: number,
  healed: boolean,
  resultCode: StorageResultCode,
): void {
  const traceId = input.traceId ?? requestTrace.getStore();
  logEvent(resultCode === "ok" || resultCode === "not_found" ? "info" : "warn", "storage_span", {
    op: input.op,
    durationMs: Math.round(performance.now() - startedAt),
    actorHash: telemetryIdHash(input.actorId),
    ...(input.artifactId ? { artifactHash: telemetryIdHash(input.artifactId) } : {}),
    resourcePath: input.resourcePath,
    resultCode,
    healed,
    ...(traceId ? { traceId } : {}),
  });
}

function safeErrorCode(code: string): string {
  const normalized = code.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
  return normalized || "unknown";
}
