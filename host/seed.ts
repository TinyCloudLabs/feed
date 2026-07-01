import type {
  FeedArtifact,
  FeedArtifactProjection,
  FeedWorkflowPackage,
  FeedWorkflowRun,
  TranscriptSourceRef,
} from "../../artifactory/skills/_shared/lib/feed-v1.ts";
import { buildGreenfieldSeed } from "../../artifactory/skills/_shared/lib/feed-v1-bootstrap.ts";
import type { FeedHostActorStorage, FeedHostStorage } from "./storage.ts";

export const SEEDED_ARTIFACT_ID = "run-seed-001:insight-card-001";

const NOW = "2026-06-29T12:00:00.000Z";
const SOURCE: TranscriptSourceRef = {
  sourceRefId: "listen:seed:fundraising-loop",
  sourceKind: "listen_conversation",
  sourceId: "conversation-seed-001",
  observedPath: "sql_transcript_json",
  observedHash: "sha256:feed-v1-seed-source",
  observedAt: NOW,
  quoteLineRefs: ["L12-L18", "L41-L47"],
};

const DISCLOSURE = {
  userCopy: "Generated from your recent Listen context using Feed-hosted OpenAI credentials.",
  credentialOwner: "feed_hosted" as const,
  providerClass: "first_party" as const,
  egressClass: "model_provider" as const,
};

export async function seedDefaultFeed(storage: FeedHostStorage, actor: FeedHostActorStorage): Promise<void> {
  const pkg: FeedWorkflowPackage = {
    schemaVersion: "feed.workflow_package.v1",
    packageId: "extract-insights",
    displayName: "Extract Insights",
    version: "1.0.0",
    digest: "sha256:seed-package-extract-insights",
    manifestKey: "skills/extract-insights/SKILL.md",
    workflowRef: "smithers://feed/extract-insights",
    workflowDigest: "sha256:seed-workflow-extract-insights",
    admissionState: "reviewed_first_party",
    disclosure: DISCLOSURE,
  };

  const artifact: FeedArtifact = {
    schemaVersion: "feed.artifact.v1",
    artifactId: SEEDED_ARTIFACT_ID,
    artifactType: "insight_card",
    renderShape: "short_form",
    title: "Practice Fish First",
    summary: "A seed artifact showing how Feed Host projections hydrate through the new Feed v1 contract.",
    body: {
      markdown:
        "Run the fundraising workflow against low-stakes targets first. Each pass should debug the software, the story, and the handoff between agents before higher-stakes investor conversations.",
      bullets: [
        "Feed Host owns projection and feedback persistence.",
        "Artifacts remain contract-shaped documents addressed by doc keys.",
        "Control intents become durable generation requests.",
      ],
    },
    sourceRefs: [SOURCE],
    producedBy: {
      packageId: pkg.packageId,
      packageVersion: pkg.version,
      packageDigest: pkg.digest,
      runId: "run-seed-001",
      runtimeClass: "feed_hosted",
      providerClass: "first_party",
      credentialOwner: "feed_hosted",
      egressClass: "model_provider",
      disclosure: DISCLOSURE,
    },
    freshness: {
      label: "fresh",
      asOf: NOW,
      lastCheckedAt: NOW,
    },
    idempotency: {
      sourceFingerprint: "sha256:seed-source-fingerprint",
      artifactFingerprint: "sha256:seed-artifact-fingerprint",
      dedupeKey: "feed-v1-seed:practice-fish-first",
    },
    storage: {
      docKey: "seed/run-seed-001/insight-card-001.json",
    },
    createdAt: NOW,
    updatedAt: NOW,
  };

  const projection: FeedArtifactProjection = {
    artifactId: artifact.artifactId,
    rankScore: 0.92,
    disposition: "default",
    visibility: "ranked",
    freshnessLabel: artifact.freshness.label,
    reasonCodes: ["seeded", "recent_listen_context", "default_internal_skill"],
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
    sourceRefs: [SOURCE],
    publishedArtifactIds: [artifact.artifactId],
    droppedCandidates: [],
    spend: { budgetId: "feed-hosted-seed", amount: 0, currency: "USD" },
    startedAt: NOW,
    finishedAt: NOW,
  };

  const seed = buildGreenfieldSeed({ pkg, run, artifact, projection });
  await storage.insertSeedRows(actor, "artifacts_index", seed.artifacts);
  await storage.insertSeedRows(actor, "feed_index", seed.feed);
  await storage.writeArtifactDocument(actor, artifact);
}
