import type {
  FeedArtifact,
  FeedArtifactProjection,
  FeedWorkflowPackage,
  FeedWorkflowRun,
} from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import { buildGreenfieldSeed } from "../../artifactory/skills/_shared/lib/feed-v1-bootstrap.ts";
import type { FeedHostActorStorage, FeedHostStorage } from "./storage.ts";
import type { FeedPost } from "../shared/feed-item.ts";
import RICH_ARTIFACT_FIXTURE from "../shared/fixtures/rich-artifact.json";

const FIXTURE = RICH_ARTIFACT_FIXTURE as unknown as FeedArtifact & { posts: FeedPost[] };

export const SEEDED_ARTIFACT_ID = FIXTURE.artifactId;

export async function seedDefaultFeed(storage: FeedHostStorage, actor: FeedHostActorStorage): Promise<void> {
  // Keep this byte-for-byte fixture vendored from Artifactory. The digest pin
  // in feed-contract.test.ts catches cross-repository drift.
  const artifact = structuredClone(FIXTURE);
  const pkg: FeedWorkflowPackage = {
    schemaVersion: "feed.workflow_package.v1",
    packageId: artifact.producedBy.packageId,
    displayName: "Weekly Product Brief",
    version: artifact.producedBy.packageVersion,
    digest: artifact.producedBy.packageDigest,
    manifestKey: "fixtures/weekly-product-brief/skill.toml",
    workflowRef: "workflows/weekly-product-brief.json",
    workflowDigest: artifact.producedBy.packageDigest,
    admissionState: "reviewed_first_party",
    disclosure: artifact.producedBy.disclosure,
  };
  const projection: FeedArtifactProjection = {
    artifactId: artifact.artifactId,
    rankScore: 0.96,
    disposition: "default",
    visibility: "ranked",
    freshnessLabel: artifact.freshness.label,
    reasonCodes: ["canonical_fixture", "first_run"],
    packageId: pkg.packageId,
    sourceFingerprint: artifact.idempotency.sourceFingerprint,
    publishedAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
  const run: FeedWorkflowRun = {
    schemaVersion: "feed.workflow_run.v1",
    runId: artifact.producedBy.runId,
    packageId: pkg.packageId,
    packageDigest: pkg.digest,
    status: "published",
    sourceRefs: artifact.sourceRefs,
    publishedArtifactIds: [artifact.artifactId],
    droppedCandidates: [],
    spend: { budgetId: "canonical-fixture", amount: 0, currency: "USD" },
    startedAt: artifact.createdAt,
    finishedAt: artifact.updatedAt,
  };

  const seed = buildGreenfieldSeed({ pkg, run, artifact, projection });
  await storage.insertSeedRows(actor, "artifacts_index", seed.artifacts);
  await storage.insertSeedRows(actor, "feed_index", seed.feed);
  await storage.writeArtifactDocument(actor, artifact);
}
