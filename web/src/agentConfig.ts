// agentConfig.ts — the RUNTIME agent config loader.
//
// The agent backend host / DID / bearer token used to be baked in at BUILD time
// via VITE_AGENT_* env (see the older agentClient.ts). That meant repointing the
// feed at a new agent (e.g. a redeployed CVM with a fresh host or DID) required a
// Vite rebuild. This module loads those values at RUNTIME from a static
// `/agent-config.json` fetched once at app startup, so an operator can repoint the
// feed by editing one committed static file and redeploying it — NO code change,
// NO VITE rebuild.
//
// Precedence (per requirement): the runtime `/agent-config.json` WINS; the
// `import.meta.env.VITE_AGENT_*` values are a fallback for LOCAL-DEV convenience
// ONLY (so `vite dev` still works with a `.env.local` and no static file). In a
// BUILT/PROD context a MISSING or MALFORMED `/agent-config.json` FAILS LOUDLY —
// we must never silently fall back to a blank/stale agent (no silent wrong-agent).
//
// Token handling — CHOICE (a): the committed `web/public/agent-config.json`
// carries host + did ONLY (both are public-safe values). The bearer token is
// sourced from `VITE_AGENT_TOKEN` at build time and is NEVER committed. The loader
// still SUPPORTS an optional `token` field in the JSON (so an operator who serves
// their own static file out-of-band can inline one), but precedence is
// config.token → VITE_AGENT_TOKEN, and the in-repo file deliberately omits it so
// no secret ever lands in git.

/** The raw shape of `/agent-config.json` as authored/deployed. All fields
 *  optional at the wire level — we validate after fetch. `host` is the agent
 *  backend origin; `did` the agent's stable did:pkh (optional — auto-discovered
 *  from GET {host}/agent/info when absent); `token` an optional inline bearer. */
interface RawAgentConfig {
  host?: unknown;
  did?: unknown;
  token?: unknown;
}

/** The resolved, validated runtime agent config the rest of the app consumes.
 *  `host` is the normalized, validated origin (https-or-loopback) — "" only in
 *  the local-dev/unconfigured case. `did` is the OPTIONAL guard DID: when present,
 *  the swapped-agent guard enforces it; when "", the guard uses the /agent/info
 *  DID (advisory). `token` is the resolved per-install bearer ("" when none). */
export interface ResolvedAgentConfig {
  host: string;
  did: string;
  token: string;
}

/** Validate the agent host as a trusted, well-formed origin before we ever POST a
 *  scoped delegation to it. HTTPS is required in general; plain HTTP is allowed
 *  ONLY for loopback dev hosts (localhost / 127.0.0.1 / [::1]). Returns the
 *  normalized origin (no trailing slash, no path) or "" when unset. An INVALID
 *  non-empty host THROWS — a misconfigured deploy must fail loudly, not silently
 *  POST a delegation to an arbitrary string. (Moved here from agentClient.ts so
 *  the same validation applies to the RESOLVED host regardless of source.) */
export function resolveAgentHost(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`agent host is not a valid URL: ${JSON.stringify(raw)}`);
  }
  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback)) {
    return url.origin;
  }
  throw new Error(
    `agent host must be https:// (http:// allowed only for localhost): got ${JSON.stringify(raw)}`,
  );
}

/** Where the runtime config lives. Served from `web/public/agent-config.json`
 *  (vite `root: "web"`, so `public/` is the static-asset root) at the site root. */
const CONFIG_URL = "/agent-config.json";

/** True in a real built/prod bundle; false under `vite dev`. Drives the loud-vs-
 *  fallback decision: in prod a missing/malformed config is a hard error, in dev
 *  it falls back to VITE_AGENT_* for convenience. */
const IS_PROD = import.meta.env.PROD;

/** Build-time VITE fallbacks — LOCAL-DEV ONLY. */
const ENV_HOST = (import.meta.env.VITE_AGENT_HOST || "").trim();
const ENV_DID = (import.meta.env.VITE_AGENT_DID || "").trim();
const ENV_TOKEN = (import.meta.env.VITE_AGENT_TOKEN || "").trim();
const ENV_CONFIG_OVERRIDE = import.meta.env.VITE_AGENT_CONFIG_OVERRIDE === "1";

/** Coerce an optional JSON string field to a trimmed string, or "" when absent.
 *  A present-but-non-string value is a malformed config → throw (loud). */
function optString(value: unknown, field: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new Error(`agent-config.json field "${field}" must be a string`);
  }
  return value.trim();
}

/** Resolve the runtime config from a fetched-or-null raw config, validating the
 *  host. `raw === null` means the fetch failed / file was absent.
 *
 *  Precedence for HOST and guard DID:
 *    PROD — runtime config is the ONLY source. A missing/blank/invalid host THROWS
 *      (loud error screen). An omitted `did` stays "" so the live /agent/info DID
 *      governs (DID auto-discovery survives a repoint). NO VITE_* fallback — it
 *      would silently boot the stale build-time host/DID.
 *    DEV — runtime config wins, else falls back to VITE_AGENT_* so `vite dev`
 *      works with a `.env.local` and a partial/absent static file. Set
 *      VITE_AGENT_CONFIG_OVERRIDE=1 to explicitly make VITE_AGENT_* win in dev
 *      for local-agent testing without committing a localhost config.
 *  TOKEN sources from VITE_AGENT_TOKEN in both modes (choice (a)).
 *
 *  PROD + null raw (missing config) THROWS — no silent fallback to a blank/stale
 *  agent. A malformed field also throws (via optString / resolveAgentHost). */
function resolveConfig(raw: RawAgentConfig | null): ResolvedAgentConfig {
  if (raw === null) {
    if (IS_PROD) {
      throw new Error(
        `agent runtime config missing: ${CONFIG_URL} could not be loaded. ` +
          `Deploy web/public/agent-config.json with at least a "host".`,
      );
    }
    // Dev fallback: no static file, use VITE_AGENT_* (validates the host too).
    return {
      host: resolveAgentHost(ENV_HOST),
      did: ENV_DID,
      token: ENV_TOKEN,
    };
  }
  // Runtime config present → it WINS, and in PROD it is the ONLY source for host
  // and guard DID — a VITE_* fallback there would silently boot the STALE build-
  // time host/DID when the deployed JSON omits a field, defeating the whole point
  // (and blocking DID auto-discovery after a repoint). The VITE_* fallback for
  // host/DID is allowed ONLY under DEV (so `vite dev` works with a `.env.local`
  // and a partial/empty static file). In dev only, VITE_AGENT_CONFIG_OVERRIDE=1
  // flips precedence so local-agent testing does not require committing a
  // localhost runtime config. Token still sources from VITE_AGENT_TOKEN by design
  // (choice (a) — the committed file carries no token).
  const rawHost = optString(raw.host, "host");
  const rawDid = optString(raw.did, "did");
  const rawToken = optString(raw.token, "token");
  // HOST: prod = runtime only; dev = runtime, else VITE fallback. In dev override
  // mode, VITE_AGENT_HOST wins when set. Always validated.
  const host = resolveAgentHost(
    IS_PROD
      ? rawHost
      : ENV_CONFIG_OVERRIDE
        ? ENV_HOST || rawHost
        : rawHost || ENV_HOST,
  );
  // A present config with no usable host is a misconfig in prod — fail loudly
  // rather than render a silently-unconfigured (or stale build-time) agent.
  if (IS_PROD && host === "") {
    throw new Error(
      `agent runtime config malformed: ${CONFIG_URL} has no "host". ` +
        `Add a valid https:// host.`,
    );
  }
  // GUARD DID: prod = config.did ONLY (absent → "" so the live /agent/info DID
  // governs and a repoint auto-discovers the new agent); dev = config.did, else
  // VITE fallback. In dev override mode, VITE_AGENT_DID wins when set.
  const did = IS_PROD ? rawDid : ENV_CONFIG_OVERRIDE ? ENV_DID || rawDid : rawDid || ENV_DID;
  return {
    host,
    did,
    token: rawToken || ENV_TOKEN,
  };
}

/** Single-flight load promise: the fetch + resolve runs at most ONCE per page
 *  load, and every agent entry point awaits THIS promise, so an agent call can
 *  never fire before the config is resolved (no race). Kicked off lazily on first
 *  `loadAgentConfig()` (which app bootstrap calls before render). */
let loadPromise: Promise<ResolvedAgentConfig> | null = null;

/** The resolved config once loaded, for the few SYNCHRONOUS readers (e.g.
 *  `agentConfigured()`). Null until the load settles. Async callers must use
 *  `loadAgentConfig()` and await it — they must not read this directly. */
let resolved: ResolvedAgentConfig | null = null;

/** Fetch `/agent-config.json` once and resolve the runtime agent config. Idempotent
 *  (single-flight): concurrent / repeat callers share one fetch. App bootstrap
 *  awaits this BEFORE the first render so the synchronous `agentConfigured()` and
 *  every async agent call see a resolved config — there is no window in which an
 *  agent call can run against an unloaded config. A network/parse failure resolves
 *  to a null raw, which `resolveConfig` turns into a LOUD error in prod (and a
 *  VITE fallback in dev). */
export function loadAgentConfig(): Promise<ResolvedAgentConfig> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    let raw: RawAgentConfig | null = null;
    try {
      // `cache: "no-store"` so a redeploy of the static file is picked up on the
      // next load rather than served stale from the HTTP cache.
      const res = await fetch(CONFIG_URL, { cache: "no-store" });
      if (res.ok) {
        raw = (await res.json()) as RawAgentConfig;
      }
      // A non-OK response (404 etc.) leaves raw === null → handled by resolveConfig
      // (loud in prod, VITE fallback in dev).
    } catch {
      // Network error / invalid JSON → raw stays null. resolveConfig decides
      // (loud in prod, fallback in dev). We do NOT swallow this into a blank
      // config silently.
      raw = null;
    }
    const cfg = resolveConfig(raw);
    resolved = cfg;
    return cfg;
  })();
  return loadPromise;
}

/** The resolved config for SYNCHRONOUS readers. Throws if read before
 *  `loadAgentConfig()` has settled — that's a bootstrap-ordering bug, not a state
 *  to paper over (app bootstrap awaits loadAgentConfig before any render). */
export function getAgentConfig(): ResolvedAgentConfig {
  if (!resolved) {
    throw new Error(
      "agent config read before load — call (and await) loadAgentConfig() at app bootstrap first",
    );
  }
  return resolved;
}
