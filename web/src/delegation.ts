export type FeedHostDelegationResource = {
  service: "tinycloud.sql" | "tinycloud.kv";
  serviceShort: "sql" | "kv";
  path: string;
  actions: string[];
};

export type FeedHostDelegationPolicy = {
  delegateDID: string;
  resources: FeedHostDelegationResource[];
};

export type FeedHostDelegationSubmission = {
  actorId: string;
  serializedDelegation: string;
};

export type FeedHostDelegationReceipt = {
  accepted: true;
  actorId: string;
  resources: string[];
  status: "activation_pending" | "preparing" | "active";
  setup?: FeedHostSetupStatus;
};

export type FeedHostSetupStatus = {
  state: "not_started" | "preparing" | "ready" | "failed";
  phase: "idle" | "bootstrap" | "artifact_check" | "seed" | "reconcile" | "ready" | "failed";
  attempt: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: { code: "preparation_failed"; message: string };
};

export type FeedHostDelegationStatus = {
  actorId: string;
  delegateDID: string;
  policyHash: string;
  currentPolicyHash: string;
  state: "missing" | "active" | "partial" | "expired" | "stale";
  complete: boolean;
  resources: Array<{ path: string; acceptedAt: string; expiresAt: string }>;
  setup?: FeedHostSetupStatus;
};
