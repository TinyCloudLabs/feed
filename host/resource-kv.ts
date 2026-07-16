import type { DelegatedAccess, KVResponse } from "@tinycloud/node-sdk";
import type {
  KVDeleteOptions,
  KVGetOptions,
  KVListOptions,
  KVListResponse,
  KVPutOptions,
  Result,
} from "@tinycloud/sdk-services";

const TINYCLOUD_NAMESPACE_PREFIX = "xyz.tinycloud.";

export type ResourceKvKeyErrorReason =
  | "empty"
  | "leading_slash"
  | "traversal"
  | "uri_scheme"
  | "absolute_namespace";

/** A caller supplied a physical/unsafe key where the host requires a relative one. */
export class ResourceKvKeyError extends Error {
  readonly code = "invalid_storage_key";
  readonly status = 400;

  constructor(
    readonly key: string,
    readonly reason: ResourceKvKeyErrorReason,
  ) {
    super(`KV key must be relative (${reason})`);
    this.name = "ResourceKvKeyError";
  }
}

export function validateRelativeKvKey(key: string): string {
  if (key.length === 0) throw new ResourceKvKeyError(key, "empty");
  if (key.startsWith("/")) throw new ResourceKvKeyError(key, "leading_slash");
  if (key.split("/").includes("..")) throw new ResourceKvKeyError(key, "traversal");
  if (key.includes("://")) throw new ResourceKvKeyError(key, "uri_scheme");
  if (key.startsWith(TINYCLOUD_NAMESPACE_PREFIX)) {
    throw new ResourceKvKeyError(key, "absolute_namespace");
  }
  return key;
}

function canonicalResourcePath(resourcePath: string): string {
  const canonical = resourcePath.replace(/\/+$/, "");
  if (!canonical.startsWith(TINYCLOUD_NAMESPACE_PREFIX) || canonical.includes("://") || canonical.split("/").includes("..")) {
    throw new Error(`invalid TinyCloud resource path: ${resourcePath}`);
  }
  return canonical;
}

/**
 * The sole compatibility conversion for rows written before doc_key became
 * relative-only. It removes this resource's namespace once, then subjects the
 * result to the same strict validation as every new key.
 */
export function relativeKeyForLegacyAbsoluteRead(resourcePath: string, storedKey: string): string {
  const namespace = canonicalResourcePath(resourcePath);
  const prefix = `${namespace}/`;
  const relative = storedKey.startsWith(prefix) ? storedKey.slice(prefix.length) : storedKey;
  return validateRelativeKvKey(relative);
}

export type ResourceKv = {
  readonly resourcePath: string;
  get<T = unknown>(relativeKey: string, options?: Omit<KVGetOptions, "prefix">): Promise<Result<KVResponse<T>>>;
  put(relativeKey: string, value: unknown, options?: Omit<KVPutOptions, "prefix">): Promise<Result<KVResponse<void>>>;
  delete(relativeKey: string, options?: Omit<KVDeleteOptions, "prefix">): Promise<Result<void>>;
  list(options?: Omit<KVListOptions, "prefix" | "path" | "removePrefix">): Promise<Result<KVListResponse>>;
};

/** Owns physical key placement for one canonical TinyCloud KV resource. */
export function resourceKv(access: DelegatedAccess, resourcePath: string): ResourceKv {
  const namespace = canonicalResourcePath(resourcePath);
  const physicalKey = (relativeKey: string) => `${namespace}/${validateRelativeKvKey(relativeKey)}`;
  return {
    resourcePath: namespace,
    get: <T = unknown>(relativeKey: string, options?: Omit<KVGetOptions, "prefix">) =>
      access.kv.get<T>(physicalKey(relativeKey), { ...options, prefix: "" }),
    put: (relativeKey: string, value: unknown, options?: Omit<KVPutOptions, "prefix">) =>
      access.kv.put(physicalKey(relativeKey), value, { ...options, prefix: "" }),
    delete: (relativeKey: string, options?: Omit<KVDeleteOptions, "prefix">) =>
      access.kv.delete(physicalKey(relativeKey), { ...options, prefix: "" }),
    list: (options?: Omit<KVListOptions, "prefix" | "path" | "removePrefix">) =>
      access.kv.list({ ...options, prefix: `${namespace}/`, removePrefix: false }),
  };
}
