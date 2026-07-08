import type {
  FeedArtifact,
  FeedArtifactProjection,
  FeedWorkflowPackage,
  FeedWorkflowRun,
  TranscriptSourceRef,
} from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import { buildGreenfieldSeed } from "../../artifactory/skills/_shared/lib/feed-v1-bootstrap.ts";
import type { FeedHostActorStorage, FeedHostStorage } from "./storage.ts";
import { DEFAULT_REVIEWED_BUNDLE } from "../shared/default-reviewed-bundle.ts";

export const SEEDED_ARTIFACT_ID = DEFAULT_REVIEWED_BUNDLE.artifactId;

export async function seedDefaultFeed(storage: FeedHostStorage, actor: FeedHostActorStorage): Promise<void> {
  const pkg: FeedWorkflowPackage = {
    schemaVersion: "feed.workflow_package.v1",
    packageId: DEFAULT_REVIEWED_BUNDLE.packageId,
    displayName: DEFAULT_REVIEWED_BUNDLE.displayName,
    version: DEFAULT_REVIEWED_BUNDLE.version,
    digest: DEFAULT_REVIEWED_BUNDLE.digest,
    manifestKey: "fixtures/default-reviewed-bundle/skill.toml",
    workflowRef: "workflows/default-reviewed-bundle.stub.json",
    workflowDigest: DEFAULT_REVIEWED_BUNDLE.workflowDigest,
    admissionState: "reviewed_first_party",
    disclosure: DEFAULT_REVIEWED_BUNDLE.disclosure,
  };

  const artifact: FeedArtifact = {
    schemaVersion: "feed.artifact.v1",
    artifactId: SEEDED_ARTIFACT_ID,
    artifactType: DEFAULT_REVIEWED_BUNDLE.artifactType,
    renderShape: "short_form",
    title: DEFAULT_REVIEWED_BUNDLE.artifactTitle,
    summary: DEFAULT_REVIEWED_BUNDLE.artifactSummary,
    body: {
      text: DEFAULT_REVIEWED_BUNDLE.artifactBodyText,
    },
    sourceRefs: [DEFAULT_REVIEWED_BUNDLE.sourceRef as TranscriptSourceRef],
    producedBy: {
      packageId: pkg.packageId,
      packageVersion: pkg.version,
      packageDigest: pkg.digest,
      runId: "run-reviewed-bundle",
      runtimeClass: DEFAULT_REVIEWED_BUNDLE.runtime.runtimeClass,
      providerClass: DEFAULT_REVIEWED_BUNDLE.runtime.providerClass,
      credentialOwner: DEFAULT_REVIEWED_BUNDLE.disclosure.credentialOwner,
      egressClass: DEFAULT_REVIEWED_BUNDLE.runtime.egressClass,
      disclosure: DEFAULT_REVIEWED_BUNDLE.disclosure,
    },
    freshness: {
      label: "fresh",
      asOf: DEFAULT_REVIEWED_BUNDLE.sourceRef.observedAt,
      lastCheckedAt: DEFAULT_REVIEWED_BUNDLE.sourceRef.observedAt,
    },
    idempotency: {
      sourceFingerprint: "sha256:feed-default-source",
      artifactFingerprint: "sha256:feed-default-artifact",
      dedupeKey: "feed-v1-default-reviewed-bundle",
    },
    storage: {
      docKey: `${SEEDED_ARTIFACT_ID}.json`,
    },
    createdAt: DEFAULT_REVIEWED_BUNDLE.sourceRef.observedAt,
    updatedAt: DEFAULT_REVIEWED_BUNDLE.sourceRef.observedAt,
  };

  const projection: FeedArtifactProjection = {
    artifactId: artifact.artifactId,
    rankScore: 0.96,
    disposition: "default",
    visibility: "ranked",
    freshnessLabel: artifact.freshness.label,
    reasonCodes: ["default_reviewed_bundle", "first_run", "stub_runtime"],
    packageId: pkg.packageId,
    sourceFingerprint: artifact.idempotency.sourceFingerprint,
    publishedAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };

  const run: FeedWorkflowRun = {
    schemaVersion: "feed.workflow_run.v1",
    runId: "run-reviewed-bundle",
    packageId: pkg.packageId,
    packageDigest: pkg.digest,
    status: "published",
    sourceRefs: [DEFAULT_REVIEWED_BUNDLE.sourceRef as TranscriptSourceRef],
    publishedArtifactIds: [artifact.artifactId],
    droppedCandidates: [],
    spend: { budgetId: "default-reviewed-bundle", amount: 0, currency: "USD" },
    startedAt: DEFAULT_REVIEWED_BUNDLE.sourceRef.observedAt,
    finishedAt: DEFAULT_REVIEWED_BUNDLE.sourceRef.observedAt,
  };

  const seed = buildGreenfieldSeed({ pkg, run, artifact, projection });
  await storage.insertSeedRows(actor, "artifacts_index", seed.artifacts);
  await storage.insertSeedRows(actor, "feed_index", seed.feed);
  await storage.writeArtifactDocument(actor, artifact);
}
