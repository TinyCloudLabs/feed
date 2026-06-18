// agentClient.ts — the bridge to the distillery agent backend.
//
// Implements the front-end half of the agent CONTRACT (FRONTEND-AGENT-PLAN §
// "Agent backend API"):
//   GET  /agent/info           → { did, name, permissions[], challenge? }
//   POST /agent/delegation     { serialized } → { ok, agentDid, delegationCid, spaceId, expiresAt }
//   POST /agent/run            {} → { run_id, status: "queued" } or 409 run_in_progress { run_id }
//   GET  /agent/run/:run_id    → { run_id, status, published?[], error? }
//
// The user mints a delegation of AGENT_SCOPES to the agent's DID with the
// signed-in session key (no extra wallet prompt — the recap already covers the
// scopes, see tinycloud.ts) and POSTs the serialized delegation to the backend,
// which runs the artifact pipeline under it, writing to the user's OWN space.
//
// The agent host / DID / token now come from the RUNTIME config (agentConfig.ts:
// `/agent-config.json`, with VITE_AGENT_* as a dev-only fallback), NOT from
// build-time env directly. App bootstrap awaits `loadAgentConfig()` before the
// first render, so `agentConfigured()` (sync) and every async call here see a
// resolved config — and `agentFetch` additionally awaits the load, so an agent
// call can never fire before the config resolves.
//
// All agent calls are gated behind the resolved host. When it is "" (unconfigured
// in dev), the agent backend is "not configured": callers MUST check
// `agentConfigured()` and render the not-connected state rather than fake success.
// In prod a missing/malformed config fails loudly during the bootstrap load.

import { serializeDelegation, type PermissionEntry } from "@tinycloud/web-sdk";
import { tcw, AGENT_SCOPES } from "./tinycloud.ts";
import { loadAgentConfig, getAgentConfig } from "./agentConfig.ts";

/** Default delegation lifetime when the backend doesn't dictate one (7 days). */
const DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Default no-progress budget: stop only after this long without a fresh backend
 *  progress log. Long generation can legitimately exceed 20 minutes; as long as
 *  Artifactory's run heartbeat keeps advancing, Feed should keep polling instead
 *  of declaring a live run stuck. */
const POLL_NO_PROGRESS_MS = 20 * 60 * 1000; // 20 min

/** True when a valid agent backend host is resolved. Reads the runtime config,
 *  which app bootstrap awaits before render — so this sync read always sees a
 *  settled config. The host-or-loopback validation already ran inside
 *  resolveAgentHost during the load, so a non-empty host here is trusted. */
export function agentConfigured(): boolean {
  return getAgentConfig().host.length > 0;
}

/** The resolved agent host origin, for display (Connect/Agents sub-lines). Reads
 *  the settled runtime config. */
export function agentHost(): string {
  return getAgentConfig().host;
}

/** Thrown when the backend's acked agentDid doesn't match the DID we delegated
 *  to (or the runtime config's guard DID, when present) — a swapped-agent guard. */
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
  /** Epoch ms the run was enqueued. */
  startedAt?: number;
  /** Epoch ms the run reached a terminal state. */
  finishedAt?: number;
  /** Bounded backend stage log tail for visibility while generation runs. */
  log?: string[];
}

export interface StartRunResult {
  run_id: string;
  status: RunStatus;
  /** True when POST /agent/run attached to an already-active backend run. */
  attached?: boolean;
}

/** One entry in GET /agent/run (the run-list endpoint), newest-first. Carries the
 *  same status vocabulary as {@link RunState} plus run timing, so a page that
 *  mounts cold can detect a build started in ANOTHER tab/session and resume it. */
export interface RunSummary {
  run_id: string;
  status: RunStatus;
  /** Epoch ms the run was enqueued. */
  startedAt: number;
  /** Epoch ms the run reached a terminal state (absent while queued|running). */
  finishedAt?: number;
  published?: PublishedArtifact[];
  error?: string;
  /** Bounded backend stage log tail. */
  log?: string[];
}

export interface RunLockSummary {
  run_id: string;
  owner: string;
  pid: number;
  acquiredAt: number;
  ageMs: number;
  reclaimable: boolean;
}

interface AgentRunsResponse {
  runs?: RunSummary[];
  lock?: RunLockSummary;
}

// ── transport ────────────────────────────────────────────────────────────────

/** A fetch that fails LOUDLY (no silent fallback) and surfaces the backend's
 *  error body when present. AWAITS the runtime config load first — so an agent
 *  call can never fire before `/agent-config.json` resolves (no race). Throws if
 *  the resolved host is unconfigured — callers should still gate on
 *  `agentConfigured()`. Honors an optional AbortSignal. Pass `auth: true` on the
 *  mutating endpoints (delegation/run) to send the per-install bearer token (from
 *  the runtime config / VITE_AGENT_TOKEN fallback); GET endpoints leave it off. */
async function agentFetch<T>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal; auth?: boolean },
): Promise<T> {
  // Await the single-flight config load — structurally prevents a pre-load call.
  const { host, token } = await loadAgentConfig();
  if (host === "") {
    throw new Error("agent backend not configured (no host in /agent-config.json)");
  }
  const res = await fetch(`${host}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.auth && token ? { Authorization: `Bearer ${token}` } : {}),
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
// later reload reuse it (no re-delegate, no extra round-trip) as long as it
// isn't expired, still targets the configured agent, AND still belongs to the
// CURRENT signed-in session's space — a delegation must NEVER be reused across
// spaces/wallets (a different wallet, or a re-keyed session, has a different
// `applications`-space URI). We persist ONLY the ack metadata (CIDs/DIDs/expiry/
// spaceId) — never the session key, which BrowserSessionStorage already owns.

/** localStorage key holding the last acked agent delegation. */
const DELEGATION_KEY = "feed:agentDelegation";

/** Load the persisted delegation ack for `currentSpaceId`, or null when absent,
 *  malformed, expired, targeting a DIFFERENT agent than a STATIC config.did, or
 *  bound to a DIFFERENT space than the active session. A stale/mismatched entry is
 *  cleared so we don't keep reconsidering it.
 *
 *  Agent-match here is only the STATIC-config.did case (sync). When config.did is
 *  ABSENT (auto-discover mode), the agent identity isn't known synchronously, so
 *  this returns a space-matched candidate WITHOUT proving its agent is current —
 *  `ensureDelegation` then fetches /agent/info and requires
 *  `ack.agentDid === info.did` before reusing it (the repoint guard). So a
 *  candidate from here is reused only after BOTH space and agent checks pass. */
export function loadStoredDelegation(currentSpaceId: string): DelegationAck | null {
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
  // A malformed/tampered expiry parses to NaN; treat that as expired (NOT as
  // "never expires") so it's dropped + refreshed rather than reused forever.
  const expiryMs = ack.expiresAt ? new Date(ack.expiresAt).getTime() : NaN;
  const expired = Number.isNaN(expiryMs) || expiryMs <= Date.now();
  // Guard DID from the RUNTIME config: enforce only when it's present. When absent
  // (auto-discover mode) the guard is advisory and runs against /agent/info later.
  const guardDid = getAgentConfig().did;
  const wrongAgent = guardDid !== "" && ack.agentDid !== guardDid;
  // Bound to a different space than the active session → it belongs to another
  // wallet / re-keyed session and must not be reused.
  const wrongSpace = ack.spaceId !== currentSpaceId;
  if (expired || wrongAgent || wrongSpace) {
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

/** Per-space single-flight guard for {@link ensureDelegation}: concurrent callers
 *  for the SAME space (App's auto-connect + the Generate button) await one shared
 *  in-flight mint instead of each POSTing /agent/delegation. Keyed by space so a
 *  mint for space A is NEVER returned to a caller for space B — a global promise
 *  would re-open the cross-session hole. The entry is deleted when its mint
 *  settles. */
const inflightEnsure = new Map<string, Promise<DelegationAck>>();

/** Ensure a usable delegation exists for `currentSpaceId`, reusing the stored
 *  one ONLY when it matches BOTH the current space AND the current agent, and
 *  otherwise minting a fresh one: GET /agent/info (fresh, so a swapped/repointed
 *  backend DID is caught) → delegateToAgent → persist the ack. Concurrent calls
 *  for the same space share one in-flight operation (single-flight, keyed by
 *  space) so the auto-connect + Generate can't double-POST.
 *
 *  Agent-match on reuse (repoint guard): `loadStoredDelegation` binds the stored
 *  ack to the space and — when a STATIC config.did is set — to that DID too, so a
 *  static-config candidate is already agent-matched and reused directly. When
 *  config.did is ABSENT (auto-discover mode), the stored ack's agent is NOT yet
 *  proven current, so we fetch /agent/info HERE and require
 *  `stored.agentDid === info.did` before reusing — a repoint to a new agent (new
 *  /agent/info DID) drops the previous agent's stale ack and forces a fresh mint
 *  rather than treating it active. Returns the ack the caller turns into
 *  DelegationInfo; the happy path needs no manual "look up"/"delegate" clicks. */
export async function ensureDelegation(currentSpaceId: string): Promise<DelegationAck> {
  const stored = loadStoredDelegation(currentSpaceId);
  // A static config.did means loadStoredDelegation already enforced the stored
  // ack's agentDid === config.did (the current agent by configuration), so a
  // surviving candidate is space- AND agent-matched: reuse without a round-trip.
  if (stored && getAgentConfig().did !== "") return stored;
  // Coalesce concurrent operations for THIS space into one. The get→set below is
  // synchronous (no await between) so two concurrent callers can't both insert.
  let pending = inflightEnsure.get(currentSpaceId);
  if (!pending) {
    pending = (async () => {
      try {
        // Auto-discover mode (no static config.did): fetch the CURRENT agent DID
        // once. Reuse the stored ack ONLY if it was minted for THIS same agent —
        // a repoint changes info.did and forces a fresh mint below.
        const info = await getAgentInfo();
        if (stored) {
          if (stored.agentDid === info.did) return stored;
          // Stored ack belongs to a DIFFERENT (previous) agent → drop it so it's
          // not reconsidered, and fall through to mint for the current agent.
          clearStoredDelegation();
        }
        const { ack } = await delegateToAgent(info.did);
        // The minted delegation must target the requested space BEFORE we persist
        // it — otherwise we'd store (and later reuse) a wrong-space delegation.
        if (ack.spaceId !== currentSpaceId) {
          throw new Error(
            `delegation space mismatch: signed in to ${currentSpaceId}, backend acked ${ack.spaceId}`,
          );
        }
        storeDelegation(ack);
        return ack;
      } finally {
        // Clear our own single-flight entry on settle (success OR failure), from
        // inside the awaited promise — no extra floating .finally() whose
        // rejection would go unhandled. Guard against clobbering a newer entry.
        if (inflightEnsure.get(currentSpaceId) === pending) {
          inflightEnsure.delete(currentSpaceId);
        }
      }
    })();
    inflightEnsure.set(currentSpaceId, pending);
  }
  const ack = await pending;
  // Defense-in-depth: re-assert the resolved ack targets THIS space before the
  // caller uses it — so even a shared in-flight promise can't yield a wrong-space
  // delegation. The per-space keying + mint-time assert above already guarantee
  // this; the redundant check is a belt-and-suspenders trust boundary.
  if (ack.spaceId !== currentSpaceId) {
    throw new Error(
      `delegation space mismatch: signed in to ${currentSpaceId}, backend acked ${ack.spaceId}`,
    );
  }
  return ack;
}

/** Mint a delegation of AGENT_SCOPES to `expectedDid` with the session key and
 *  POST it to the backend. `expectedDid` MUST come from a FRESH GET /agent/info
 *  on every (re-)grant — never a cached value — so a swapped backend DID is
 *  caught here. After the POST, the ack's `agentDid` is verified against
 *  `expectedDid` (and against the runtime config's guard DID when present);
 *  any mismatch throws `AgentDidMismatchError` (we delegated scoped caps to a
 *  different principal than the backend claims). When the config has no `did`
 *  (auto-discover mode) the guard becomes advisory: we trust /agent/info's DID and
 *  only assert the backend's ack matches it. Returns the ack + whether the wallet
 *  prompted (it shouldn't, given the broadened recap — diagnostic). */
export async function delegateToAgent(
  expectedDid: string,
): Promise<{ ack: DelegationAck; prompted: boolean }> {
  // Guard DID from the RUNTIME config: when present, the /agent/info DID we're
  // about to delegate to MUST match it (swapped-agent guard). When absent
  // (auto-discover) this check is skipped and the guard is advisory.
  const guardDid = getAgentConfig().did;
  if (guardDid && expectedDid !== guardDid) {
    throw new AgentDidMismatchError(guardDid, expectedDid);
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

/** POST /agent/run — trigger a pipeline run under the stored delegation. If the
 *  backend's cross-process run lock reports an already-active run, attach to that
 *  run instead of surfacing a generic 409 error; the caller will poll the returned
 *  id and render the real terminal status. */
export async function startRun(): Promise<StartRunResult> {
  const { host, token } = await loadAgentConfig();
  if (host === "") {
    throw new Error("agent backend not configured (no host in /agent-config.json)");
  }
  const res = await fetch(`${host}/agent/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({}),
  });
  const body = await res.text().catch(() => "");
  if (res.ok) {
    return JSON.parse(body) as StartRunResult;
  }

  let parsed: { error?: { code?: string; message?: string; run_id?: string } } | null = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  const error = parsed?.error;
  if (res.status === 409 && error?.code === "run_in_progress" && typeof error.run_id === "string") {
    return { run_id: error.run_id, status: "running", attached: true };
  }

  throw new Error(
    `agent POST /agent/run failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
  );
}

/** GET /agent/run/:run_id — current status of a run. */
export async function getRun(runId: string, signal?: AbortSignal): Promise<RunState> {
  return agentFetch<RunState>(`/agent/run/${encodeURIComponent(runId)}`, { signal });
}

/** GET /agent/runs — the run list (newest-first), used to detect a build that's
 *  already in flight (this tab, another tab, or another session) so a cold page
 *  load can resume it instead of starting a duplicate.
 *
 *  FORWARD-COMPAT DEGRADATION: this endpoint is newer than the rest of the
 *  contract, so an agent that hasn't been redeployed yet will 404 it. A 404 (or a
 *  network failure reaching the host) is treated as "this agent can't tell us its
 *  runs" → we return `[]` (no active build) rather than throwing, so the feature
 *  no-ops cleanly against an older backend. This is the ONE sanctioned soft
 *  failure: it's not hiding a misconfig (the host is the same one every other call
 *  uses), it's tolerating a not-yet-deployed route. A NON-404 HTTP error from the
 *  configured host (401/403/5xx) is a real fault and STILL throws — we don't
 *  swallow auth/transport problems. Returns `null` for the degraded case so callers
 *  can distinguish "endpoint unavailable" from "available, zero runs". */
async function fetchRunsResponse(signal?: AbortSignal): Promise<AgentRunsResponse | null> {
  // We can't use agentFetch here (it throws on every non-OK), because we must
  // branch on the 404 to degrade gracefully. Mirror its config-await + host gate.
  const { host } = await loadAgentConfig();
  if (host === "") {
    throw new Error("agent backend not configured (no host in /agent-config.json)");
  }
  let res: Response;
  try {
    res = await fetch(`${host}/agent/runs`, {
      headers: { "Content-Type": "application/json" },
      signal,
    });
  } catch (e) {
    // A genuine abort propagates (the caller cancelled). Any other network error
    // means the endpoint is unreachable — treat as "older backend, no list" so a
    // not-yet-redeployed agent doesn't break the page.
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return null;
  }
  // 404 → endpoint not deployed on this (older) agent: degrade to "unknown/none".
  if (res.status === 404) return null;
  if (!res.ok) {
    // A real fault on the configured host (auth/transport/5xx) must surface, not
    // hide — same loud-failure rule as agentFetch.
    const body = await res.text().catch(() => "");
    throw new Error(
      `agent GET /agent/runs failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ""}`,
    );
  }
  return (await res.json()) as AgentRunsResponse;
}

export async function listRuns(signal?: AbortSignal): Promise<RunSummary[] | null> {
  const data = await fetchRunsResponse(signal);
  if (!data) return null;
  return Array.isArray(data.runs) ? data.runs : [];
}

export async function getRunLock(signal?: AbortSignal): Promise<RunLockSummary | null> {
  const data = await fetchRunsResponse(signal);
  return data?.lock ?? null;
}

/** The newest run that is still in flight (status queued|running), or undefined
 *  when there's none / the list endpoint is unavailable (older backend). Used on
 *  page mount to resume an in-progress build without starting a duplicate. The
 *  list is newest-first per the contract, so the first active entry IS the newest.
 *  Passes through `listRuns`'s soft-404 behavior: an unavailable endpoint yields
 *  undefined ("none active"), while a real fault still throws. */
export async function getActiveRun(signal?: AbortSignal): Promise<RunSummary | undefined> {
  const runs = await listRuns(signal);
  if (!runs) return undefined; // endpoint unavailable → treat as none active.
  return runs.find((r) => r.status === "queued" || r.status === "running");
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

function lastProgressAt(state: RunState): number {
  const logs = Array.isArray(state.log) ? state.log : [];
  for (let i = logs.length - 1; i >= 0; i--) {
    const line = logs[i];
    if (typeof line !== "string") continue;
    const parsed = Date.parse(line.slice(0, 24));
    if (Number.isFinite(parsed)) return parsed;
  }
  return typeof state.startedAt === "number" ? state.startedAt : Date.now();
}

/** Poll a run to a terminal state (done|error), calling `onUpdate` on each poll.
 *  BOUNDED + ABORTABLE: stops after `maxNoProgressMs` (default 20 min) with no
 *  fresh progress log so it can't spin forever against a dead backend process,
 *  while allowing long active generations to continue as heartbeat logs arrive.
 *  Aborts immediately when `signal` fires (caller passes an AbortController it
 *  cancels on unmount/sign-out). Throws on transport failure or timeout; an
 *  `error` STATUS is a valid terminal result the caller renders. */
export async function pollRun(
  runId: string,
  onUpdate: (state: RunState) => void,
  options: { intervalMs?: number; maxNoProgressMs?: number; signal?: AbortSignal } = {},
): Promise<RunState> {
  const intervalMs = options.intervalMs ?? 2000;
  const maxNoProgressMs = options.maxNoProgressMs ?? POLL_NO_PROGRESS_MS;
  for (;;) {
    const state = await getRun(runId, options.signal);
    onUpdate(state);
    if (state.status === "done" || state.status === "error") return state;
    const lastProgress = lastProgressAt(state);
    if (Date.now() - lastProgress >= maxNoProgressMs) {
      throw new Error(
        `run ${runId} made no progress for ${Math.round(maxNoProgressMs / 60000)} min (last status: ${state.status})`,
      );
    }
    await abortableDelay(intervalMs, options.signal);
  }
}
