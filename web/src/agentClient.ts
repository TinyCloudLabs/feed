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
import { tcw, AGENT_SCOPES } from "./tinycloud.ts";

const AGENT_HOST = (import.meta.env.VITE_AGENT_HOST || "").replace(/\/$/, "");

/** Default delegation lifetime when the backend doesn't dictate one (7 days). */
const DELEGATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** True when an agent backend host is configured at build time. */
export function agentConfigured(): boolean {
  return AGENT_HOST.length > 0;
}

export { AGENT_HOST };

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
 *  must gate on `agentConfigured()` first. */
async function agentFetch<T>(path: string, init?: RequestInit): Promise<T> {
  if (!agentConfigured()) {
    throw new Error("agent backend not configured (VITE_AGENT_HOST is unset)");
  }
  const res = await fetch(`${AGENT_HOST}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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

/** Mint a delegation of AGENT_SCOPES to `agentDid` with the session key and POST
 *  it to the backend. Returns the backend's ack (cid + expiry) plus whether the
 *  wallet prompted (it shouldn't, given the broadened recap — surfaced for
 *  diagnostics). */
export async function delegateToAgent(
  agentDid: string,
): Promise<{ ack: DelegationAck; prompted: boolean }> {
  const { delegation, prompted } = await tcw().delegateTo(agentDid, AGENT_SCOPES, {
    expiry: DELEGATION_EXPIRY_MS,
  });
  const serialized = serializeDelegation(delegation);
  const ack = await agentFetch<DelegationAck>("/agent/delegation", {
    method: "POST",
    body: JSON.stringify({ serialized }),
  });
  return { ack, prompted };
}

/** POST /agent/run — trigger a pipeline run under the stored delegation. */
export async function startRun(): Promise<{ run_id: string; status: RunStatus }> {
  return agentFetch<{ run_id: string; status: RunStatus }>("/agent/run", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** GET /agent/run/:run_id — current status of a run. */
export async function getRun(runId: string): Promise<RunState> {
  return agentFetch<RunState>(`/agent/run/${encodeURIComponent(runId)}`);
}

/** Poll a run to a terminal state (done|error). Calls `onUpdate` on every poll.
 *  Returns the terminal RunState. Throws only on transport failure — an `error`
 *  status is a valid terminal result the caller renders. */
export async function pollRun(
  runId: string,
  onUpdate: (state: RunState) => void,
  intervalMs = 2000,
): Promise<RunState> {
  for (;;) {
    const state = await getRun(runId);
    onUpdate(state);
    if (state.status === "done" || state.status === "error") return state;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
