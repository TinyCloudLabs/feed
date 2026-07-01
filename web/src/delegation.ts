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
};
