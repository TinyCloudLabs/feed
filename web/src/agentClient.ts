// agentClient.ts — the bridge to the distillery agent backend.
//
// Implements the front-end half of the agent CONTRACT (FRONTEND-AGENT-PLAN §
// "Agent backend API"):
//   GET  /agent/info           → { did, name, permissions[], challenge? }
//   POST /agent/delegation     { serialized } → { ok, agentDid, delegationCid, spaceId, expiresAt }
//   POST /agent/run            {} → { run_id, status: "queued" }
//   GET  /agent/run/:run_id    → { run_id, status, published?[], error? }
//
// The user mints a delegation of AGENT_SCOPES to the agent's DID with the
// signed-in session key (no extra wallet prompt — the recap already covers the
// scopes, see tinycloud.ts) and POSTs the serialized delegation to the backend,
// which runs the artifact pipeline under it, writing to the user's OWN space.
//
// All agent calls are gated behind VITE_AGENT_HOST. When it is unset, the agent
// backend is "not configured": callers MUST check `agentConfigured()` and render
// the not-connected state rather than fake success.

import { serializeDelegation, type PermissionEntry } from "@tinycloud/web-sdk";
import { tcw, AGENT_SCOPES, AGENT_DID } from "./tinycloud.ts";

/** Default delegation lifetime when the backend doesn't dictate one (7 days). */
const DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Default poll budget: stop after this long even if the run never terminates
 *  (the backend is unreachable / stuck), so the loop can't spin forever. */
const POLL_MAX_ELAPSED_MS = 20 * 60 * 1000; // 20 min

/** Validate VITE_AGENT_HOST as a trusted, well-formed origin before we ever POST
 *  a scoped delegation to it. HTTPS is required in general; plain HTTP is allowed
 *  ONLY for loopback dev hosts (localhost / 127.0.0.1 / [::1]). Returns the
 *  normalized origin (no trailing slash, no path) or "" when unset/invalid.
 *  An INVALID non-empty host throws at module load — a misconfigured deploy must
 *  fail loudly, not silently POST a delegation to an arbitrary string. */
function resolveAgentHost(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`VITE_AGENT_HOST is not a valid URL: ${JSON.stringify(raw)}`);
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
    `VITE_AGENT_HOST must be https:// (http:// allowed only for localhost): got ${JSON.stringify(raw)}`,
  );
}

const AGENT_HOST = resolveAgentHost(import.meta.env.VITE_AGENT_HOST || "");

/** The per-install bearer token the backend requires on its mutating endpoints
 *  (POST /agent/delegation, POST /agent/run). Read from VITE_AGENT_TOKEN at build
 *  time. When unset, those POSTs carry no auth header and the backend answers 401
 *  — the correct loud behavior (a misconfigured token must fail visibly, not
 *  silently succeed). GET /agent/info and GET /agent/run/:id stay unauthenticated. */
const AGENT_TOKEN = (import.meta.env.VITE_AGENT_TOKEN || "").trim();

/** True when a valid agent backend host is configured. */
export function agentConfigured(): boolean {
  return AGENT_HOST.length > 0;
}

export { AGENT_HOST };

/** Thrown when the backend's acked agentDid doesn't match the DID we delegated
 *  to (or the configured VITE_AGENT_DID) — a swapped-agent guard. */
export class AgentDidMismatchError extends Error {
  constructor(expected: string, got: string) {
    super(`agent DID mismatch: delegated to ${expected}, backend acked ${got}`);
    this.name = "AgentDidMismatchError";
  }
}

// ── contract response shapes ─────────────────────────────────────────────────

export interface AgentInfo {
  did: string;
  name: string;
  permissions: PermissionEntry[];
  challenge?: string;
}

export interface DelegationAck {
  ok: true;
  agentDid: string;
  delegationCid: string;
  spaceId: string;
  /** ISO-8601 expiry of the stored delegation. */
  expiresAt: string;
}

export type RunStatus = "queued" | "running" | "done" | "error";

export interface PublishedArtifact {
  type: string;
  slug: string;
}

export interface RunState {
  run_id: string;
  status: RunStatus;
  published?: PublishedArtifact[];
  error?: string;
}

// ── transport ────────────────────────────────────────────────────────────────

/** A fetch that fails LOUDLY (no silent fallback) and surfaces the backend's
 *  error body when present. Throws if the agent host is unconfigured — callers
 *  must gate on `agentConfigured()` first. Honors an optional AbortSignal. Pass
 *  `auth: true` on the mutating endpoints (delegation/run) to send the per-install
 *  bearer token (VITE_AGENT_TOKEN); GET endpoints leave it off. */
async function agentFetch<T>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal; auth?: boolean },
): Promise<T> {
  if (!agentConfigured()) {
    throw new Error("agent backend not configured (VITE_AGENT_HOST is unset)");
  }
  const res = await fetch(`${AGENT_HOST}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.auth && AGENT_TOKEN ? { Authorization: `Bearer ${AGENT_TOKEN}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `agent ${init?.method ?? "GET"} ${path} failed: ${res.status} ${res.statusText}${
        body ? ` — ${body}` : ""
      }`,
    );
  }
  return (await res.json()) as T;
}

// ── endpoints ────────────────────────────────────────────────────────────────

/** GET /agent/info — the agent's DID + the permissions it requests. */
export async function getAgentInfo(): Promise<AgentInfo> {
  return agentFetch<AgentInfo>("/agent/info");
}

// ── delegation persistence ─────────────────────────────────────────────────
//
// The acked delegation is durable: the user delegated AGENT_SCOPES to the agent
// for DELEGATION_EXPIRY_MS, and the backend stored it. Persisting the ack lets a
// later reload reuse it (no re-delegate, no extra round-trip) as long as it isn't
// expired and still targets the configured agent. We persist ONLY the ack
// metadata (CIDs/DIDs/expiry) — never the session key, which BrowserSessionStorage
// already owns.

/** localStorage key holding the last acked agent delegation. */
const DELEGATION_KEY = "feed:agentDelegation";

/** Load a previously persisted delegation ack, or null when absent, malformed,
 *  expired, or targeting a DIFFERENT agent than the configured VITE_AGENT_DID.
 *  A stale/mismatched entry is cleared so we don't keep reconsidering it. */
export function loadStoredDelegation(): DelegationAck | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(DELEGATION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let ack: DelegationAck;
  try {
    ack = JSON.parse(raw) as DelegationAck;
  } catch {
    clearStoredDelegation();
    return null;
  }
  // Expired, or pinned to a different agent than this build trusts → drop it.
  const expired = !ack.expiresAt || new Date(ack.expiresAt).getTime() <= Date.now();
  const wrongAgent = AGENT_DID !== "" && ack.agentDid !== AGENT_DID;
  if (expired || wrongAgent) {
    clearStoredDelegation();
    return null;
  }
  return ack;
}

/** Persist the acked delegation for reuse across reloads. */
export function storeDelegation(ack: DelegationAck): void {
  try {
    localStorage.setItem(DELEGATION_KEY, JSON.stringify(ack));
  } catch {
    // localStorage unavailable — the delegation still works this session.
  }
}

/** Drop the persisted delegation (sign-out, local revoke, or staleness). */
export function clearStoredDelegation(): void {
  try {
    localStorage.removeItem(DELEGATION_KEY);
  } catch {
    // ignore
  }
}

/** Ensure a usable delegation exists, reusing the stored one when valid and
 *  otherwise minting a fresh one automatically: GET /agent/info (fresh, so a
 *  swapped backend DID is caught) → delegateToAgent → persist the ack. Returns
 *  the ack the caller turns into DelegationInfo. The happy path needs no manual
 *  "look up"/"delegate" clicks — this IS that flow, run on demand. */
export async function ensureDelegation(): Promise<DelegationAck> {
  const stored = loadStoredDelegation();
  if (stored) return stored;
  const info = await getAgentInfo();
  const { ack } = await delegateToAgent(info.did);
  storeDelegation(ack);
  return ack;
}

/** Mint a delegation of AGENT_SCOPES to `expectedDid` with the session key and
 *  POST it to the backend. `expectedDid` MUST come from a FRESH GET /agent/info
 *  on every (re-)grant — never a cached value — so a swapped backend DID is
 *  caught here. After the POST, the ack's `agentDid` is verified against
 *  `expectedDid` (and against the build-time VITE_AGENT_DID when configured);
 *  any mismatch throws `AgentDidMismatchError` (we delegated scoped caps to a
 *  different principal than the backend claims). Returns the ack + whether the
 *  wallet prompted (it shouldn't, given the broadened recap — diagnostic). */
export async function delegateToAgent(
  expectedDid: string,
): Promise<{ ack: DelegationAck; prompted: boolean }> {
  if (AGENT_DID && expectedDid !== AGENT_DID) {
    throw new AgentDidMismatchError(AGENT_DID, expectedDid);
  }
  const { delegation, prompted } = await tcw().delegateTo(expectedDid, AGENT_SCOPES, {
    expiry: DELEGATION_EXPIRY_MS,
  });
  const serialized = serializeDelegation(delegation);
  const ack = await agentFetch<DelegationAck>("/agent/delegation", {
    method: "POST",
    auth: true,
    body: JSON.stringify({ serialized }),
  });
  if (ack.agentDid !== expectedDid) {
    throw new AgentDidMismatchError(expectedDid, ack.agentDid);
  }
  return { ack, prompted };
}

/** POST /agent/run — trigger a pipeline run under the stored delegation. */
export async function startRun(): Promise<{ run_id: string; status: RunStatus }> {
  return agentFetch<{ run_id: string; status: RunStatus }>("/agent/run", {
    method: "POST",
    auth: true,
    body: JSON.stringify({}),
  });
}

/** GET /agent/run/:run_id — current status of a run. */
export async function getRun(runId: string, signal?: AbortSignal): Promise<RunState> {
  return agentFetch<RunState>(`/agent/run/${encodeURIComponent(runId)}`, { signal });
}

/** Sleep that rejects promptly when `signal` aborts (so a cancelled poll doesn't
 *  hang for the rest of its interval). */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const id = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Poll a run to a terminal state (done|error), calling `onUpdate` on each poll.
 *  BOUNDED + ABORTABLE: stops after `maxElapsedMs` (default 20 min) so it can't
 *  spin forever against a stuck/unreachable backend, and aborts immediately when
 *  `signal` fires (caller passes an AbortController it cancels on unmount/sign-
 *  out). Throws on transport failure or timeout; an `error` STATUS is a valid
 *  terminal result the caller renders. */
export async function pollRun(
  runId: string,
  onUpdate: (state: RunState) => void,
  options: { intervalMs?: number; maxElapsedMs?: number; signal?: AbortSignal } = {},
): Promise<RunState> {
  const intervalMs = options.intervalMs ?? 2000;
  const maxElapsedMs = options.maxElapsedMs ?? POLL_MAX_ELAPSED_MS;
  const deadline = Date.now() + maxElapsedMs;
  for (;;) {
    const state = await getRun(runId, options.signal);
    onUpdate(state);
    if (state.status === "done" || state.status === "error") return state;
    if (Date.now() + intervalMs >= deadline) {
      throw new Error(
        `run ${runId} did not finish within ${Math.round(maxElapsedMs / 60000)} min (last status: ${state.status})`,
      );
    }
    await abortableDelay(intervalMs, options.signal);
  }
}
