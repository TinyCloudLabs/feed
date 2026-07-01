export type MediaKind = "hero" | "audio" | "video" | "media";

export interface MediaDiagnosticContext {
  kind: MediaKind;
  key?: string | null;
  slug?: string | null;
  mime?: string | null;
}

export interface MediaDiagnosticFields {
  [key: string]: string | number | boolean | null | undefined;
}

const STORAGE_KEY = "tinyfeed:media-debug";

function devEnv(): boolean {
  return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);
}

function localHost(): boolean {
  if (typeof location === "undefined") return false;
  return location.hostname === "localhost" || location.hostname.endsWith(".localhost");
}

export function mediaDiagnosticsEnabled(): boolean {
  try {
    const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(STORAGE_KEY);
    if (stored === "1" || stored === "true") return true;
    if (stored === "0" || stored === "false") return false;
  } catch {
    // localStorage can be blocked; fall back to environment/host checks.
  }
  return devEnv() || localHost();
}

function shortKey(key?: string | null): string | undefined {
  if (!key) return undefined;
  if (key.length <= 96) return key;
  return `${key.slice(0, 48)}...${key.slice(-32)}`;
}

function elapsed(startMs: number): number {
  const now = typeof performance === "undefined" ? Date.now() : performance.now();
  return Math.round(now - startMs);
}

export function mediaDebug(
  event: string,
  context: MediaDiagnosticContext,
  fields: MediaDiagnosticFields = {},
): void {
  if (!mediaDiagnosticsEnabled()) return;
  const payload = {
    event,
    kind: context.kind,
    slug: context.slug || undefined,
    key: shortKey(context.key),
    mime: context.mime || undefined,
    ...fields,
  };
  console.info("[TinyFeed media]", payload);
}

export function mediaTimer(
  event: string,
  context: MediaDiagnosticContext,
  fields: MediaDiagnosticFields = {},
): (doneEvent: string, doneFields?: MediaDiagnosticFields) => void {
  const startMs = typeof performance === "undefined" ? Date.now() : performance.now();
  mediaDebug(`${event}:start`, context, fields);
  return (doneEvent, doneFields = {}) => {
    mediaDebug(doneEvent, context, { ...fields, ...doneFields, elapsedMs: elapsed(startMs) });
  };
}

