// Shared page-level types.

import type {
  RunStatus,
  PublishedArtifact,
  HeldArtifact,
  RunMediaSummary,
} from "../agentClient.ts";

/** The active delegation as acked by the backend (POST /agent/delegation). */
export interface DelegationInfo {
  agentDid: string;
  delegationCid: string;
  spaceId: string;
  /** ISO-8601 expiry. */
  expiresAt: string;
}

/** One entry in the Agents-page run history. */
export interface RunRecord {
  runId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  published?: PublishedArtifact[];
  held?: HeldArtifact[];
  media?: RunMediaSummary;
  error?: string;
  log?: string[];
}
