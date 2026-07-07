// Shared page-level types.

import type {
  RunStatus,
  PublishedArtifact,
  HeldArtifact,
  RunMediaSummary,
  RunProof,
  RunMixPlan,
  RunCorpusPlan,
  RunExecutionSource,
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
  executionSource?: RunExecutionSource;
  targetArtifactType?: string;
  corpusPlan?: RunCorpusPlan;
  mixPlan?: RunMixPlan;
  proof?: RunProof;
  error?: string;
  log?: string[];
}
